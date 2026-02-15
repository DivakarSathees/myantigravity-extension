import * as vscode from 'vscode';

const PROXY_PORT = 8000;

// Store the proxy base URL received from the webview
// This will be set by the webview when it loads (e.g., "http://localhost:14122/proxy/8000")
let PROXY_BASE_URL = `http://localhost:${PROXY_PORT}`; // Default fallback
// function getProxyBaseUrl(): string {
//     const cfg = vscode.workspace.getConfiguration('neuralstack');
//     return cfg.get<string>('proxyBaseUrl') || '';
// }

// let PROXY_BASE_URL = getProxyBaseUrl();

let currentDiffEditor: vscode.TextEditor | undefined;
let pendingChanges: Map<string, any> = new Map();



export function activate(context: vscode.ExtensionContext) {
    const provider = new AntigravityViewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('neuralstack.chatView', provider)
    );



    // Command to accept file changes
    context.subscriptions.push(
        vscode.commands.registerCommand('neuralstack.acceptChange', async (changeId: string) => {
            try {
                const response = await fetch(`${PROXY_BASE_URL}/approve-file-change`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ change_id: changeId, approved: true })
                });
                const data: any = await response.json();
                if (data.ok) {
                    vscode.window.showInformationMessage(`✅ Changes applied to: ${data.file_path}`);
                    // Close diff editor
                    if (currentDiffEditor) {
                        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                    }
                    // Refresh file
                    const doc = await vscode.workspace.openTextDocument(data.file_path);
                    await vscode.window.showTextDocument(doc);
                }
            } catch (error: any) {
                vscode.window.showErrorMessage(`Error accepting changes: ${error.message}`);
            }
        })
    );

    // Command to reject file changes
    context.subscriptions.push(
        vscode.commands.registerCommand('neuralstack.rejectChange', async (changeId: string) => {
            try {
                const response = await fetch(`${PROXY_BASE_URL}/approve-file-change`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ change_id: changeId, approved: false })
                });
                const data: any = await response.json();
                if (data.ok) {
                    vscode.window.showWarningMessage(`❌ Changes rejected for: ${data.file_path}`);
                    // Close diff editor
                    if (currentDiffEditor) {
                        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                    }
                }
            } catch (error: any) {
                vscode.window.showErrorMessage(`Error rejecting changes: ${error.message}`);
            }
        })
    );

    // Listen for file change notifications
    provider.onFileChange(async (changeData: any) => {
        await showDiffInEditor(changeData);
    });
}

async function showDiffInEditor(changeData: any) {
    try {
        const { change_id, file_path, diff, is_new_file, preview, new_content, old_content } = changeData;

        // Store change data
        pendingChanges.set(change_id, changeData);

        console.log('Opening diff for:', file_path);
        console.log('Is new file:', is_new_file);
        console.log('Has new_content:', !!new_content);
        console.log('Has old_content:', !!old_content);

        // Detect language from file extension
        const getLanguage = (path: string) => {
            if (path.endsWith('.py')) return 'python';
            if (path.endsWith('.js')) return 'javascript';
            if (path.endsWith('.ts')) return 'typescript';
            if (path.endsWith('.tsx')) return 'typescriptreact';
            if (path.endsWith('.jsx')) return 'javascriptreact';
            if (path.endsWith('.json')) return 'json';
            if (path.endsWith('.html')) return 'html';
            if (path.endsWith('.css')) return 'css';
            if (path.endsWith('.md')) return 'markdown';
            return 'plaintext';
        };

        if (is_new_file) {
            // For new files, show the content in a new untitled document
            const doc = await vscode.workspace.openTextDocument({
                content: new_content || preview || '',
                language: getLanguage(file_path)
            });

            currentDiffEditor = await vscode.window.showTextDocument(doc, {
                preview: false,
                viewColumn: vscode.ViewColumn.One
            });

            // Show info message with buttons
            const result = await vscode.window.showInformationMessage(
                `📝 New file proposed: ${file_path}`,
                'Accept',
                'Reject'
            );

            if (result === 'Accept') {
                await vscode.commands.executeCommand('neuralstack.acceptChange', change_id);
            } else if (result === 'Reject') {
                await vscode.commands.executeCommand('neuralstack.rejectChange', change_id);
            }
        } else {
            // For existing files, show diff using untitled documents
            const originalContent = old_content || '';
            const modifiedContent = new_content || '';

            // Create untitled documents for comparison
            const originalDoc = await vscode.workspace.openTextDocument({
                content: originalContent,
                language: getLanguage(file_path)
            });

            const modifiedDoc = await vscode.workspace.openTextDocument({
                content: modifiedContent,
                language: getLanguage(file_path)
            });

            // Open diff editor
            await vscode.commands.executeCommand(
                'vscode.diff',
                originalDoc.uri,
                modifiedDoc.uri,
                `${file_path} (Proposed Changes)`
            );

            // Show action buttons
            const result = await vscode.window.showInformationMessage(
                `📝 Review changes to: ${file_path}`,
                'Accept',
                'Reject'
            );

            if (result === 'Accept') {
                await vscode.commands.executeCommand('neuralstack.acceptChange', change_id);
            } else if (result === 'Reject') {
                await vscode.commands.executeCommand('neuralstack.rejectChange', change_id);
            }
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Error showing diff: ${error.message}`);
    }
}

class AntigravityViewProvider implements vscode.WebviewViewProvider {
    private _fileChangeCallback?: (data: any) => void;

    constructor(private readonly _extensionUri: vscode.Uri) { }

    public onFileChange(callback: (data: any) => void) {
        this._fileChangeCallback = callback;
    }

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        webviewView.webview.options = { enableScripts: true };
        const provider = this;

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message.type === 'setProxyUrl') {
                // Store the proxy base URL from the webview
                PROXY_BASE_URL = message.proxyBaseUrl;
                console.log('📡 Extension received proxy URL:', PROXY_BASE_URL);
            } else if (message.type === 'viewDiff') {
                try {
                    // Check if content was provided directly (from applied changes panel)
                    if (message.oldContent !== undefined || message.newContent !== undefined) {
                        await showDiffInEditor({
                            change_id: message.changeId,
                            file_path: message.filePath,
                            diff: '',
                            is_new_file: message.isNewFile || false,
                            preview: message.newContent,
                            new_content: message.newContent || '',
                            old_content: message.oldContent || ''
                        });
                    } else {
                        // Fetch from server (legacy pending changes or applied changes)
                        let response = await fetch(`${PROXY_BASE_URL}/applied-change/${message.changeId}`);
                        let data: any = await response.json();

                        // Try pending changes if not found in applied
                        if (!data.ok) {
                            response = await fetch(`${PROXY_BASE_URL}/get-pending-change/${message.changeId}`);
                            data = await response.json();
                        }

                        if (data.ok) {
                            await showDiffInEditor({
                                change_id: message.changeId,
                                file_path: message.filePath || data.change.file_path,
                                diff: data.change.diff,
                                is_new_file: data.change.is_new_file,
                                preview: data.change.new_content,
                                new_content: data.change.new_content,
                                old_content: data.change.old_content
                            });
                        } else {
                            vscode.window.showErrorMessage('Failed to load file change: ' + (data.message || 'Not found'));
                        }
                    }
                } catch (error: any) {
                    vscode.window.showErrorMessage('Error viewing diff: ' + error.message);
                }
            }
        });

        // Get workspace folder path
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspacePath = workspaceFolders && workspaceFolders.length > 0
            ? workspaceFolders[0].uri.fsPath
            : '';

        // The HTML for your sidebar with separate chat and terminal views
        webviewView.webview.html = `
            <!DOCTYPE html>
            <html>
            <head>
            <meta http-equiv="Content-Security-Policy"
                content="
                    default-src 'none';
                    img-src https: data:;
                    style-src 'unsafe-inline';
                    script-src 'unsafe-inline';
                    connect-src http: https: ws: wss:;
                ">
            <style>
                body {
                    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
                    margin: 0;
                    padding: 10px;
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                }
                h3 {
                    margin: 0 0 10px 0;
                    color: var(--vscode-foreground);
                }
                .section {
                    margin-bottom: 15px;
                }
                .section-title {
                    font-size: 11px;
                    text-transform: uppercase;
                    color: var(--vscode-descriptionForeground);
                    margin-bottom: 5px;
                    font-weight: bold;
                }
                #chat {
                    height: 200px;
                    overflow-y: auto;
                    border: 1px solid var(--vscode-panel-border);
                    background-color: var(--vscode-editor-background);
                    margin-bottom: 5px;
                    padding: 8px;
                    font-size: 13px;
                }
                #terminal {
                    height: 250px;
                    overflow-y: auto;
                    border: 1px solid var(--vscode-terminal-border);
                    background-color: var(--vscode-terminal-background);
                    color: var(--vscode-terminal-foreground);
                    margin-bottom: 5px;
                    padding: 10px;
                    font-size: 12px;
                    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
                    line-height: 1.5;
                }
                .terminal-line {
                    margin: 2px 0;
                    white-space: pre-wrap;
                    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
                }
                .terminal-prompt {
                    color: var(--vscode-terminal-ansiBrightGreen);
                    font-weight: bold;
                }
                .terminal-command {
                    color: var(--vscode-terminal-ansiWhite);
                    display: inline;
                }
                .terminal-output {
                    color: var(--vscode-terminal-ansiBrightBlue);
                    margin-left: 0;
                    padding-left: 0;
                }
                .terminal-error {
                    color: var(--vscode-terminal-ansiBrightRed);
                }
                .terminal-success {
                    color: var(--vscode-terminal-ansiBrightGreen);
                }
                .terminal-warning {
                    color: var(--vscode-terminal-ansiBrightYellow);
                }
                .file-operation {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 4px 8px;
                    margin: 2px 0;
                    border-radius: 3px;
                    font-size: 12px;
                }
                .file-operation.read {
                    background-color: rgba(100, 150, 255, 0.1);
                    border-left: 3px solid var(--vscode-terminal-ansiBrightBlue);
                    color: var(--vscode-terminal-ansiBrightBlue);
                }
                .file-operation.write {
                    background-color: rgba(255, 200, 100, 0.1);
                    border-left: 3px solid var(--vscode-terminal-ansiBrightYellow);
                    color: var(--vscode-terminal-ansiBrightYellow);
                }
                .file-operation.done {
                    background-color: rgba(100, 255, 100, 0.1);
                    border-left: 3px solid var(--vscode-terminal-ansiBrightGreen);
                    color: var(--vscode-terminal-ansiBrightGreen);
                }
                .confirmation-box {
                    background-color: var(--vscode-input-background);
                    border: 2px solid var(--vscode-terminal-ansiBrightYellow);
                    padding: 12px;
                    margin: 10px 0;
                    border-radius: 4px;
                }
                .confirmation-message {
                    color: var(--vscode-terminal-ansiBrightYellow);
                    font-weight: bold;
                    margin-bottom: 8px;
                }
                .confirmation-command {
                    background-color: var(--vscode-terminal-background);
                    padding: 8px;
                    margin: 8px 0;
                    border-left: 3px solid var(--vscode-terminal-ansiBrightCyan);
                    font-family: 'Consolas', 'Monaco', monospace;
                    color: var(--vscode-terminal-ansiBrightCyan);
                }
                .confirmation-buttons {
                    display: flex;
                    gap: 8px;
                    margin-top: 8px;
                }
                .confirm-btn {
                    flex: 1;
                    padding: 8px 16px;
                    border: none;
                    border-radius: 3px;
                    cursor: pointer;
                    font-weight: bold;
                    font-size: 12px;
                    transition: all 0.2s;
                }
                .confirm-btn-yes {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }
                .confirm-btn-yes:hover {
                    background-color: var(--vscode-button-hoverBackground);
                    transform: scale(1.02);
                }
                .confirm-btn-no {
                    background-color: var(--vscode-inputValidation-errorBackground);
                    color: var(--vscode-inputValidation-errorForeground);
                }
                .confirm-btn-no:hover {
                    opacity: 0.8;
                    transform: scale(1.02);
                }
                .file-diff-box {
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-terminal-ansiBrightCyan);
                    padding: 8px 12px;
                    margin: 8px 0;
                    border-radius: 4px;
                }
                .diff-compact {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                .diff-compact-header {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    flex: 1;
                }
                .diff-icon {
                    font-size: 16px;
                }
                .diff-file-name {
                    color: var(--vscode-terminal-ansiBrightYellow);
                    font-family: monospace;
                    font-weight: bold;
                    flex: 1;
                }
                .diff-badge {
                    font-size: 11px;
                    padding: 2px 8px;
                    border-radius: 3px;
                    background-color: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                }
                .diff-compact-actions {
                    display: flex;
                    gap: 8px;
                    justify-content: flex-end;
                }
                .diff-btn-compact {
                    padding: 4px 12px;
                    border: none;
                    border-radius: 3px;
                    cursor: pointer;
                    font-size: 12px;
                    font-weight: 500;
                    transition: opacity 0.2s;
                }
                .diff-btn-compact:hover {
                    opacity: 0.8;
                }
                .diff-btn-view {
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }
                .diff-btn-accept {
                    background-color: var(--vscode-testing-iconPassed);
                    color: #fff;
                }
                .diff-btn-reject {
                    background-color: var(--vscode-testing-iconFailed);
                    color: #fff;
                }
                .diff-header {
                    color: var(--vscode-terminal-ansiBrightCyan);
                    font-weight: bold;
                    margin-bottom: 8px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                .diff-file-path {
                    color: var(--vscode-terminal-ansiBrightYellow);
                    font-family: monospace;
                }
                .diff-content {
                    background-color: var(--vscode-terminal-background);
                    padding: 10px;
                    margin: 8px 0;
                    border-radius: 3px;
                    font-family: 'Consolas', 'Monaco', monospace;
                    font-size: 11px;
                    white-space: pre;
                    overflow-x: auto;
                }
                .diff-line-add {
                    background-color: rgba(0, 255, 0, 0.1);
                    color: var(--vscode-terminal-ansiBrightGreen);
                }
                .diff-line-remove {
                    background-color: rgba(255, 0, 0, 0.1);
                    color: var(--vscode-terminal-ansiBrightRed);
                }
                .diff-line-context {
                    color: var(--vscode-terminal-foreground);
                }
                .diff-buttons {
                    display: flex;
                    gap: 8px;
                    margin-top: 10px;
                }
                .diff-btn {
                    flex: 1;
                    padding: 8px 16px;
                    border: none;
                    border-radius: 3px;
                    cursor: pointer;
                    font-weight: bold;
                    font-size: 12px;
                }
                .diff-btn-accept {
                    background-color: var(--vscode-testing-iconPassed);
                    color: #000;
                }
                .diff-btn-reject {
                    background-color: var(--vscode-testing-iconFailed);
                    color: #fff;
                }
                .modal {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background-color: rgba(0, 0, 0, 0.7);
                    z-index: 1000;
                }
                .modal-content {
                    background-color: var(--vscode-editor-background);
                    margin: 50px auto;
                    padding: 0;
                    border: 1px solid var(--vscode-panel-border);
                    width: 90%;
                    max-width: 500px;
                    border-radius: 4px;
                    max-height: 70%;
                    overflow-y: auto;
                }
                .modal-header {
                    padding: 15px;
                    background-color: var(--vscode-titleBar-activeBackground);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                .modal-title {
                    font-weight: bold;
                    color: var(--vscode-titleBar-activeForeground);
                }
                .modal-close {
                    color: var(--vscode-titleBar-activeForeground);
                    font-size: 28px;
                    font-weight: bold;
                    cursor: pointer;
                }
                .modal-close:hover {
                    color: var(--vscode-errorForeground);
                }
                .session-item {
                    padding: 12px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    cursor: pointer;
                    transition: background-color 0.2s;
                }
                .session-item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .session-item-title {
                    font-weight: bold;
                    color: var(--vscode-foreground);
                    margin-bottom: 4px;
                }
                .session-item-meta {
                    font-size: 10px;
                    color: var(--vscode-descriptionForeground);
                }
                .session-item-delete {
                    float: right;
                    color: var(--vscode-errorForeground);
                    font-size: 16px;
                    margin-left: 10px;
                }
                .session-item-delete:hover {
                    color: var(--vscode-testing-iconFailed);
                }
                .chat-message {
                    margin: 5px 0;
                    padding: 5px;
                    border-radius: 3px;
                }
                .user-message {
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                }
                .agent-message {
                    background-color: var(--vscode-editor-selectionBackground);
                    color: var(--vscode-editor-foreground);
                }
                /* Option buttons for agent questions */
                .agent-options {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 6px;
                    margin-top: 8px;
                    padding-top: 8px;
                    border-top: 1px solid var(--vscode-panel-border);
                }
                .option-btn {
                    padding: 6px 12px;
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border: 1px solid var(--vscode-button-border);
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 11px;
                    transition: all 0.2s;
                    text-align: left;
                    max-width: 100%;
                }
                .option-btn:hover {
                    background-color: var(--vscode-button-secondaryHoverBackground);
                    transform: translateY(-1px);
                }
                .option-btn.primary {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }
                .option-btn.primary:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                .quick-reply-container {
                    margin-top: 8px;
                    padding: 8px;
                    background-color: var(--vscode-input-background);
                    border-radius: 4px;
                    border: 1px dashed var(--vscode-panel-border);
                }
                .quick-reply-label {
                    font-size: 10px;
                    color: var(--vscode-descriptionForeground);
                    margin-bottom: 6px;
                    display: block;
                }
                .input-container {
                    display: flex;
                    gap: 5px;
                    position: relative;
                }
                .input-wrapper {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    position: relative;
                }
                #input {
                    flex: 1;
                    padding: 6px;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 2px;
                }
                /* File mention dropdown styles */
                .file-picker-dropdown {
                    position: absolute;
                    bottom: 100%;
                    left: 0;
                    right: 0;
                    max-height: 200px;
                    overflow-y: auto;
                    background-color: var(--vscode-dropdown-background);
                    border: 1px solid var(--vscode-dropdown-border);
                    border-radius: 4px;
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
                    z-index: 1000;
                    margin-bottom: 4px;
                    display: none;
                }
                .file-picker-dropdown.visible {
                    display: block;
                }
                .file-picker-header {
                    padding: 8px;
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                .file-picker-search {
                    width: 100%;
                    padding: 6px 8px;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: none;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    font-size: 12px;
                }
                .file-picker-search:focus {
                    outline: none;
                    background-color: var(--vscode-inputOption-activeBackground);
                }
                .file-picker-item {
                    padding: 6px 10px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    font-size: 12px;
                    transition: background-color 0.1s;
                }
                .file-picker-item:hover, .file-picker-item.selected {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .file-picker-item .file-icon {
                    font-size: 14px;
                }
                .file-picker-item .file-path {
                    color: var(--vscode-descriptionForeground);
                    font-size: 10px;
                    margin-left: auto;
                }
                /* Prompt picker dropdown (same layout as file picker) */
                .prompt-picker-dropdown {
                    position: absolute;
                    bottom: 100%;
                    left: 0;
                    right: 0;
                    max-height: 220px;
                    overflow-y: auto;
                    background-color: var(--vscode-dropdown-background);
                    border: 1px solid var(--vscode-dropdown-border);
                    border-radius: 4px;
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
                    z-index: 1000;
                    margin-bottom: 4px;
                    display: none;
                }
                .prompt-picker-dropdown.visible {
                    display: block;
                }
                .prompt-picker-header {
                    padding: 6px 10px;
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .prompt-picker-item {
                    padding: 8px 10px;
                    cursor: pointer;
                    display: flex;
                    align-items: flex-start;
                    gap: 8px;
                    font-size: 12px;
                    transition: background-color 0.1s;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .prompt-picker-item:last-child { border-bottom: none; }
                .prompt-picker-item:hover, .prompt-picker-item.selected {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .prompt-picker-item .prompt-icon { font-size: 14px; flex-shrink: 0; }
                .prompt-picker-item .prompt-label { font-weight: 500; }
                .prompt-picker-item .prompt-desc { color: var(--vscode-descriptionForeground); font-size: 10px; margin-top: 2px; }
                .prompt-picker-item .prompt-needs-folder { font-size: 10px; color: var(--vscode-badge-foreground); margin-left: auto; }
                /* Folder picker - same position/layout as file picker (above input) */
                .folder-picker-dropdown {
                    position: absolute;
                    bottom: 100%;
                    left: 0;
                    right: 0;
                    max-height: 200px;
                    min-height: 80px;
                    overflow-y: auto;
                    overflow-x: hidden;
                    display: none;
                    margin-bottom: 4px;
                    background-color: var(--vscode-dropdown-background);
                    border: 1px solid var(--vscode-dropdown-border);
                    border-radius: 4px;
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
                    z-index: 1000;
                }
                .folder-picker-dropdown.visible {
                    display: block;
                }
                .folder-picker-header {
                    padding: 6px 10px;
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                #folder-list {
                    min-height: 60px;
                }
                .folder-picker-item {
                    padding: 6px 10px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    font-size: 12px;
                    transition: background-color 0.1s;
                }
                .folder-picker-item:hover, .folder-picker-item.selected {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .folder-picker-item .folder-path { color: var(--vscode-descriptionForeground); font-size: 10px; margin-left: auto; }
                .folder-picker-empty, .folder-picker-loading {
                    padding: 15px;
                    text-align: center;
                    color: var(--vscode-descriptionForeground);
                    font-size: 12px;
                }
                .file-picker-empty {
                    padding: 15px;
                    text-align: center;
                    color: var(--vscode-descriptionForeground);
                    font-size: 12px;
                }
                .file-picker-loading {
                    padding: 15px;
                    text-align: center;
                    color: var(--vscode-descriptionForeground);
                }
                /* Selected files chips */
                .selected-files-container {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 4px;
                    margin-bottom: 6px;
                    min-height: 0;
                }
                .selected-files-container:empty {
                    display: none;
                }
                .file-chip {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    padding: 2px 8px;
                    background-color: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    border-radius: 12px;
                    font-size: 11px;
                    max-width: 200px;
                }
                .file-chip .file-chip-name {
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .file-chip .file-chip-remove {
                    cursor: pointer;
                    font-size: 14px;
                    line-height: 1;
                    opacity: 0.7;
                }
                /* Selected folders chips - same style as files */
                .selected-folders-container {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 4px;
                    margin-bottom: 6px;
                    min-height: 0;
                }
                .selected-folders-container:empty {
                    display: none;
                }
                .folder-chip {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    padding: 2px 8px;
                    background-color: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    border-radius: 12px;
                    font-size: 11px;
                    max-width: 200px;
                }
                .folder-chip .folder-chip-name {
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .folder-chip .folder-chip-remove {
                    cursor: pointer;
                    font-size: 14px;
                    line-height: 1;
                    opacity: 0.7;
                }
                .file-chip .file-chip-remove:hover {
                    opacity: 1;
                }
                /* Selected prompts chips - same style as files/folders */
                .selected-prompts-container {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 4px;
                    margin-bottom: 6px;
                    min-height: 0;
                }
                .selected-prompts-container:empty {
                    display: none;
                }
                .prompt-chip {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    padding: 2px 8px;
                    background-color: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    border-radius: 12px;
                    font-size: 11px;
                    max-width: 200px;
                }
                .prompt-chip .prompt-chip-name {
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .prompt-chip .prompt-chip-remove {
                    cursor: pointer;
                    font-size: 14px;
                    line-height: 1;
                    opacity: 0.7;
                }
                .prompt-chip .prompt-chip-remove:hover {
                    opacity: 1;
                }
                button {
                    padding: 6px 12px;
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    border-radius: 2px;
                    cursor: pointer;
                }
                button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                .status {
                    font-size: 11px;
                    padding: 3px 6px;
                    border-radius: 2px;
                    display: inline-block;
                    margin-bottom: 5px;
                }
                .status-connected {
                    background-color: var(--vscode-testing-iconPassed);
                    color: #000;
                }
                .status-disconnected {
                    background-color: var(--vscode-testing-iconFailed);
                    color: #fff;
                }
                /* Progress Panel Styles */
                .progress-panel {
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                    margin: 8px 0;
                    padding: 10px;
                    display: none;
                }
                .progress-panel.visible {
                    display: block;
                }
                .progress-header {
                    font-size: 11px;
                    font-weight: bold;
                    color: var(--vscode-foreground);
                    margin-bottom: 8px;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }
                .progress-header .spinner {
                    width: 12px;
                    height: 12px;
                    border: 2px solid var(--vscode-progressBar-background);
                    border-top: 2px solid var(--vscode-button-background);
                    border-radius: 50%;
                    animation: spin 1s linear infinite;
                }
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                .progress-tasks {
                    list-style: none;
                    padding: 0;
                    margin: 0;
                }
                .progress-task {
                    display: flex;
                    align-items: flex-start;
                    gap: 8px;
                    padding: 4px 0;
                    font-size: 12px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .progress-task:last-child {
                    border-bottom: none;
                }
                .progress-task-icon {
                    width: 16px;
                    height: 16px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    flex-shrink: 0;
                }
                .progress-task-icon.pending {
                    color: var(--vscode-descriptionForeground);
                }
                .progress-task-icon.in_progress {
                    color: var(--vscode-button-background);
                }
                .progress-task-icon.completed {
                    color: var(--vscode-testing-iconPassed);
                }
                .progress-task-icon.error {
                    color: var(--vscode-testing-iconFailed);
                }
                .progress-task-content {
                    flex: 1;
                }
                .progress-task-name {
                    color: var(--vscode-foreground);
                    font-weight: 500;
                }
                .progress-task-name.completed {
                    color: var(--vscode-descriptionForeground);
                }
                .progress-task-details {
                    font-size: 10px;
                    color: var(--vscode-descriptionForeground);
                    margin-top: 2px;
                }
                .task-mini-spinner {
                    width: 12px;
                    height: 12px;
                    border: 2px solid var(--vscode-panel-border);
                    border-top: 2px solid var(--vscode-button-background);
                    border-radius: 50%;
                    animation: spin 1s linear infinite;
                    display: inline-block;
                }
                /* Changed Files Panel Styles */
                .changed-files-panel {
                    background-color: var(--vscode-sideBar-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                    margin: 8px 0;
                    overflow: hidden;
                }
                .changed-files-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 8px 10px;
                    background-color: var(--vscode-sideBarSectionHeader-background);
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .changed-files-title {
                    font-size: 11px;
                    font-weight: bold;
                    text-transform: uppercase;
                    color: var(--vscode-sideBarSectionHeader-foreground);
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }
                .changed-files-count {
                    background-color: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    padding: 1px 6px;
                    border-radius: 10px;
                    font-size: 10px;
                }
                .changed-files-actions {
                    display: flex;
                    gap: 4px;
                }
                .changed-files-action-btn {
                    padding: 2px 6px;
                    font-size: 10px;
                    border: none;
                    border-radius: 3px;
                    cursor: pointer;
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }
                .changed-files-action-btn:hover {
                    background-color: var(--vscode-button-secondaryHoverBackground);
                }
                .changed-files-action-btn.accept-all {
                    background-color: var(--vscode-testing-iconPassed);
                    color: #fff;
                }
                .changed-files-action-btn.revert-all {
                    background-color: var(--vscode-testing-iconFailed);
                    color: #fff;
                }
                .changed-files-list {
                    max-height: 200px;
                    overflow-y: auto;
                }
                .changed-file-item {
                    display: flex;
                    align-items: center;
                    padding: 6px 10px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    font-size: 12px;
                    gap: 8px;
                }
                .changed-file-item:last-child {
                    border-bottom: none;
                }
                .changed-file-item.reverted {
                    opacity: 0.5;
                    text-decoration: line-through;
                }
                .changed-file-item.accepted {
                    background-color: rgba(0, 255, 0, 0.05);
                }
                .changed-file-icon {
                    font-size: 14px;
                    width: 18px;
                    text-align: center;
                }
                .changed-file-icon.new {
                    color: var(--vscode-testing-iconPassed);
                }
                .changed-file-icon.modified {
                    color: var(--vscode-gitDecoration-modifiedResourceForeground);
                }
                .changed-file-name {
                    flex: 1;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    color: var(--vscode-foreground);
                }
                .changed-file-status {
                    font-size: 10px;
                    padding: 1px 4px;
                    border-radius: 3px;
                }
                .changed-file-status.applied {
                    background-color: var(--vscode-inputValidation-warningBackground);
                    color: var(--vscode-inputValidation-warningForeground);
                }
                .changed-file-status.accepted {
                    background-color: var(--vscode-testing-iconPassed);
                    color: #fff;
                }
                .changed-file-status.reverted {
                    background-color: var(--vscode-testing-iconFailed);
                    color: #fff;
                }
                .changed-file-actions {
                    display: flex;
                    gap: 4px;
                }
                .changed-file-btn {
                    padding: 2px 6px;
                    font-size: 10px;
                    border: none;
                    border-radius: 3px;
                    cursor: pointer;
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }
                .changed-file-btn:hover {
                    opacity: 0.8;
                }
                .changed-file-btn.view {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }
                .changed-file-btn.accept {
                    background-color: var(--vscode-testing-iconPassed);
                    color: #fff;
                }
                .changed-file-btn.revert {
                    background-color: var(--vscode-testing-iconFailed);
                    color: #fff;
                }
                .no-changes-message {
                    padding: 15px;
                    text-align: center;
                    color: var(--vscode-descriptionForeground);
                    font-size: 12px;
                }
            </style>
            </head>
            <body>
                <h3>🚀 NeuralStack Agent</h3>
                
                <div class="section">
                    <div class="section-title">
                        Chat Sessions
                        <button onclick="showSessions()" style="float: right; font-size: 10px; padding: 2px 6px; margin-left: 5px;">History</button>
                        <button onclick="newChat()" style="float: right; font-size: 10px; padding: 2px 6px; margin-left: 5px;">New Chat</button>
                        <button onclick="clearHistory()" style="float: right; font-size: 10px; padding: 2px 6px;">Clear</button>
                    </div>
                    <div id="session-title" style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 5px; padding: 3px;"></div>
                    <div id="chat"></div>
                    <div id="selected-files" class="selected-files-container"></div>
                    <div id="selected-folders" class="selected-folders-container"></div>
                    <div id="selected-prompts" class="selected-prompts-container"></div>
                    <div class="input-container">
                        <div class="input-wrapper">
                            <div id="file-picker" class="file-picker-dropdown">
                                <input type="text" class="file-picker-search" id="file-search" placeholder="Search files..." oninput="filterFiles(this.value)">
                                <div id="file-list"></div>
                            </div>
                            <div id="folder-picker" class="folder-picker-dropdown">
                                <input type="text" class="file-picker-search" id="folder-search" placeholder="Search folders..." oninput="filterFolders(this.value)">
                                <div id="folder-list"></div>
                            </div>
                            <div id="prompt-picker" class="prompt-picker-dropdown">
                                <input type="text" class="file-picker-search" id="prompt-search" placeholder="Search default prompts..." oninput="filterPrompts(this.value)">
                                <div id="prompt-list"></div>
                            </div>
                            <input id="input" type="text" placeholder="Type @ for files, / for folders, > for default prompts..." onkeydown="handleInputKeyDown(event)" oninput="handleInputChange(event)">
                        </div>
                        <button onclick="send()" id="send-btn">Send</button>
                        <button type="button" id="stop-agent-btn" onclick="stopAgent()" style="display: none; padding: 6px 12px; font-size: 12px; background: #d9534f; color: white; border: none; border-radius: 4px; cursor: pointer;" title="Stop the running agent">⏹ Stop</button>
                    </div>
                    <div style="font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 4px;">💡 Type @ for files · Type / for folders · Type &gt; for default prompts</div>
                </div>
                
                <div id="sessions-modal" class="modal" style="display: none;">
                    <div class="modal-content">
                        <div class="modal-header">
                            <span class="modal-title">📚 Chat History</span>
                            <span class="modal-close" onclick="closeSessions()">&times;</span>
                        </div>
                        <div id="sessions-list"></div>
                    </div>
                </div>

                <!-- Changed Files Panel -->
                <div id="changed-files-panel" class="changed-files-panel" style="display: none;">
                    <div class="changed-files-header">
                        <div class="changed-files-title">
                            📁 Changed Files
                            <span id="changed-files-count" class="changed-files-count">0</span>
                        </div>
                        <div class="changed-files-actions">
                            <button class="changed-files-action-btn accept-all" onclick="acceptAllChanges()" title="Accept All">✓ All</button>
                            <button class="changed-files-action-btn revert-all" onclick="revertAllChanges()" title="Revert All">↩ All</button>
                            <button class="changed-files-action-btn" onclick="clearChangedFiles()" title="Clear List">🗑</button>
                        </div>
                    </div>
                    <div id="changed-files-list" class="changed-files-list"></div>
                </div>

                <div class="section">
                    <div class="section-title">Terminal Output</div>
                    <div id="status" class="status status-disconnected">⚪ Connecting...</div>
                    
                    <!-- Progress Panel -->
                    <div id="progress-panel" class="progress-panel">
                        <div class="progress-header">
                            <div class="spinner"></div>
                            <span>Agent Working...</span>
                        </div>
                        <ul id="progress-tasks" class="progress-tasks"></ul>
                    </div>
                    
                    <div id="terminal"></div>
                    
                    <!-- Process controls for interactive input and kill -->
                    <div id="process-controls" style="display: none; margin-top: 8px; padding: 8px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 4px;">
                        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
                            <span style="font-size: 11px; color: var(--vscode-descriptionForeground);">🔄 Process running: <span id="process-id-display"></span></span>
                        </div>
                        <div style="display: flex; gap: 6px;">
                            <input id="process-input" type="text" placeholder="Type input for process..." 
                                   style="flex: 1; padding: 6px; font-size: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px;"
                                   onkeypress="if(event.key==='Enter') sendProcessInput()">
                            <button onclick="sendProcessInput()" style="padding: 6px 12px; font-size: 11px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; cursor: pointer;">Send</button>
                            <button onclick="killProcess()" style="padding: 6px 12px; font-size: 11px; background: #d9534f; color: white; border: none; border-radius: 3px; cursor: pointer;">🛑 Kill (Ctrl+C)</button>
                        </div>
                    </div>
                </div>

                <script>
    const PROXY_PORT = 8000;

    // HTTP base for REST calls
    const PROXY_BASE = \`\${location.origin}/proxy/\${PROXY_PORT}\`;

    // WebSocket base
    const WS_BASE =
      (location.protocol === 'https:' ? 'wss://' : 'ws://') +
      location.host +
      \`/proxy/\${PROXY_PORT}\`;

    console.log('🔗 PROXY_BASE:', PROXY_BASE);
    console.log('🔌 WS_BASE:', WS_BASE);

    const vscode = acquireVsCodeApi();
    
    // Send the proxy base URL to the extension context
    vscode.postMessage({
        type: 'setProxyUrl',
        proxyBaseUrl: PROXY_BASE
    });
    
    const chatContainer = document.getElementById('chat');
    const terminalContainer = document.getElementById('terminal');
    const statusDiv = document.getElementById('status');

    let socket = null;
    let reconnectAttempts = 0;
    let sessionId = null;  // Store session ID for chat history
    let agentRequestInProgress = false;  // True while /chat request is in flight (show Stop button)
    let currentSessionTitle = "New Chat";
    let currentProcessId = null;  // Track running process for input/kill
    
    // Workspace path from VS Code (injected from extension)
    const workspacePath = '${workspacePath.replace(/\\/g, '\\\\')}' || '';
    
    // =============================================
    // @ File Mention Feature
    // =============================================
    let selectedFiles = [];  // Array of selected file objects
    let workspaceFiles = []; // Cached list of workspace files
    let filePickerVisible = false;
    let selectedFileIndex = -1;
    
    // =============================================
    // > Default prompts (Type > to show - same format as @ and /)
    // =============================================
    const PREDEFINED_PROMPTS = [
        { id: 'create-scaffolding', label: 'Create scaffolding (empty solution + run.sh from templates)', prompt: 'Create scaffolding for the selected project using the workspace sample templates. First look for template structure in this workspace under folders like templates/scaffolding or scaffolding-templates (or similar). Read those templates (empty solution structure and run.sh files), then create the same scaffolding in the target folder: empty solution layout and run.sh files based on the templates. Target folder: {{folder}}', needsFolder: true },
        { id: 'java-scaffold', label: 'Java scaffolding for selected directory', prompt: 'Make a Java scaffolding for the selected directory: {{folder}}', needsFolder: true },
        { id: 'scenario-md', label: 'Scenario-based problem description (MD)', prompt: 'Create a scenario-based problem description for this selected project/folder in an md file. Target folder: {{folder}}', needsFolder: true },
        { id: 'analyze-project', label: 'Analyze this project', prompt: 'Analyze the project structure and give a brief overview of technologies, entry points, and suggestions.', needsFolder: false },
        { id: 'readme', label: 'Generate README for project', prompt: 'Generate a README.md for this project describing setup, usage, and structure.', needsFolder: false },
        { id: 'refactor-selected', label: 'Refactor and clean selected code', prompt: 'Refactor and clean the code in the selected files for readability and best practices.', needsFolder: false }
    ];
    let promptPickerVisible = false;
    let selectedPromptIndex = 0;
    let filteredPromptsForPicker = [];  // PREDEFINED_PROMPTS filtered by search (same format as file/folder picker)
    let selectedPrompts = [];  // Array of selected prompt chips: { id, label, prompt, needsFolder }
    let pendingPromptForFolder = null;  // { prompt, placeholder } when waiting for folder pick (legacy flow)
    let folderPickerVisible = false;
    let selectedFolderIndex = 0;
    let workspaceFoldersList = [];  // Cached list from backend (same workspace as @ files)
    let selectedFolders = [];  // Array of selected folder objects (like selectedFiles)

    
    // Get file icon based on extension
    function getFileIcon(filename) {
        const ext = filename.split('.').pop().toLowerCase();
        const icons = {
            'py': '🐍',
            'js': '📜',
            'ts': '💠',
            'tsx': '⚛️',
            'jsx': '⚛️',
            'html': '🌐',
            'css': '🎨',
            'json': '📋',
            'md': '📝',
            'txt': '📄',
            'yaml': '⚙️',
            'yml': '⚙️',
            'sh': '🖥️',
            'sql': '🗃️',
            'git': '📦',
            'env': '🔐',
            'svg': '🖼️',
            'png': '🖼️',
            'jpg': '🖼️',
            'jpeg': '🖼️'
        };
        return icons[ext] || '📄';
    }
    
    // Fetch workspace files from backend
    async function fetchWorkspaceFiles(search = '') {
        try {
            const response = await fetch('http://localhost:8000' + '/list-workspace-files', {
            // const response = await fetch(PROXY_BASE + '/list-workspace-files', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ 
                    search: search,
                    workspace_path: workspacePath  // Pass workspace path
                })
            });
            const data = await response.json();
            if (data.ok) {
                workspaceFiles = data.files;
                return data.files;
            } else {
                console.error('File list error:', data.message);
            }
            return [];
        } catch (error) {
            console.error('Error fetching files:', error);
            return [];
        }
    }
    
    // Fetch workspace folders from backend (same workspace as @ files)
    async function fetchWorkspaceFolders(search) {
        try {
            const base = (typeof PROXY_BASE !== 'undefined' && PROXY_BASE) ? PROXY_BASE : ('http://localhost:8000');
            // const response = await fetch(base + '/list-workspace-folders', {
            const response = await fetch('http://localhost:8000' + '/list-workspace-folders', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ search: search || '', workspace_path: workspacePath })
            });
            const data = await response.json();
            if (data.ok && Array.isArray(data.folders)) {
                workspaceFoldersList = data.folders;
                return data.folders;
            }
            return [];
        } catch (e) {
            console.error('Error fetching folders:', e);
            return [];
        }
    }
    
    // Show file picker dropdown
    async function showFilePicker() {
        const picker = document.getElementById('file-picker');
        console.log('picker file picker:', picker);
        const fileList = document.getElementById('file-list');
        const searchInput = document.getElementById('file-search');
        
        filePickerVisible = true;
        picker.classList.add('visible');
        
        // Show loading
        fileList.innerHTML = '<div class="file-picker-loading">⏳ Loading files...</div>';
        
        // Fetch files
        const files = await fetchWorkspaceFiles();
        console.log('files:', files);
        renderFileList(files);
        
        // Focus search input
        setTimeout(() => searchInput.focus(), 50);
    }
    
    // Hide file picker dropdown
    function hideFilePicker() {
        const picker = document.getElementById('file-picker');
        picker.classList.remove('visible');
        filePickerVisible = false;
        selectedFileIndex = -1;
        
        // Clear search
        const searchInput = document.getElementById('file-search');
        if (searchInput) searchInput.value = '';
    }
    
    // Render file list in dropdown
    function renderFileList(files) {
        const fileList = document.getElementById('file-list');
        
        if (files.length === 0) {
            fileList.innerHTML = '<div class="file-picker-empty">No files found</div>';
            return;
        }
        
        // Filter out already selected files
        const filteredFiles = files.filter(f => 
            !selectedFiles.some(sf => sf.path === f.path)
        );
        
        if (filteredFiles.length === 0) {
            fileList.innerHTML = '<div class="file-picker-empty">All matching files already selected</div>';
            return;
        }
        
        fileList.innerHTML = filteredFiles.map((file, index) => \`
            <div class="file-picker-item\${index === selectedFileIndex ? ' selected' : ''}" 
                 data-path="\${file.path}"
                 data-full-path="\${file.full_path}"
                 data-name="\${file.name}"
                 onclick="selectFile(this)">
                <span class="file-icon">\${getFileIcon(file.name)}</span>
                <span class="file-name">\${file.name}</span>
                <span class="file-path">\${file.path}</span>
            </div>
        \`).join('');
    }
    
    // Filter files based on search
    async function filterFiles(search) {
        const files = await fetchWorkspaceFiles(search);
        renderFileList(files);
        selectedFileIndex = -1;
    }
    
    // Select a file from the dropdown
    function selectFile(element) {
        const file = {
            path: element.dataset.path,
            full_path: element.dataset.fullPath,
            name: element.dataset.name
        };
        
        // Add to selected files
        if (!selectedFiles.some(f => f.path === file.path)) {
            selectedFiles.push(file);
            updateSelectedFilesDisplay();
        }
        
        // Hide picker and focus input
        hideFilePicker();
        
        // Remove @ from input if present
        const input = document.getElementById('input');
        input.value = input.value.replace(/@\\s*$/, '');
        input.focus();
    }
    
    // Update the display of selected files (chips)
    function updateSelectedFilesDisplay() {
        const container = document.getElementById('selected-files');
        
        container.innerHTML = selectedFiles.map(file => \`
            <div class="file-chip" data-path="\${file.path}">
                <span>\${getFileIcon(file.name)}</span>
                <span class="file-chip-name">\${file.name}</span>
                <span class="file-chip-remove" onclick="removeSelectedFile('\${file.path}')">&times;</span>
            </div>
        \`).join('');
    }
    
    // Remove a selected file
    function removeSelectedFile(path) {
        selectedFiles = selectedFiles.filter(f => f.path !== path);
        updateSelectedFilesDisplay();
    }
    
    // Handle input keydown for @ detection and navigation
    // function handleInputKeyDown(event) {
    //     if (folderPickerVisible) {
    //         console.log('folderPickerVisible is true');
    //     }
    //     if (filePickerVisible) {
    //         const items = document.querySelectorAll('.file-picker-item');
            
    //         if (event.key === 'ArrowDown') {
    //             event.preventDefault();
    //             selectedFileIndex = Math.min(selectedFileIndex + 1, items.length - 1);
    //             updateFileSelection(items);
    //         } else if (event.key === 'ArrowUp') {
    //             event.preventDefault();
    //             selectedFileIndex = Math.max(selectedFileIndex - 1, 0);
    //             updateFileSelection(items);
    //         } else if (event.key === 'Enter' && selectedFileIndex >= 0) {
    //             event.preventDefault();
    //             items[selectedFileIndex].click();
    //         } else if (event.key === 'Escape') {
    //             event.preventDefault();
    //             hideFilePicker();
    //             document.getElementById('input').focus();
    //         }
    //     } else if (event.key === 'Enter') {
    //         send();
    //     }
    // }
    
    // Update visual selection in file list
    function updateFileSelection(items) {
        items.forEach((item, index) => {
            item.classList.toggle('selected', index === selectedFileIndex);
        });
        
        // Scroll selected item into view
        if (selectedFileIndex >= 0 && items[selectedFileIndex]) {
            items[selectedFileIndex].scrollIntoView({ block: 'nearest' });
        }
    }
    
    // Handle input changes for >, @ and / detection
    function handleInputChange(event) {
        const input = event.target;
        const value = input.value;
        const cursorPos = input.selectionStart;
        const textBeforeCursor = value.substring(0, cursorPos);
        
        // Check if > is typed at cursor (default/saved prompts - same format as @ and /)
        const gtMatch = textBeforeCursor.match(/\\>(\\w*)$/);
        if (gtMatch) {
            if (!promptPickerVisible) {
                if (filePickerVisible) hideFilePicker();
                if (folderPickerVisible) hideFolderPicker();
                showPromptPicker(gtMatch[1] || '');
            }
            return;
        }
        
        // Check if / is typed at cursor (folder picker)
        const slashMatch = textBeforeCursor.match(/\\/(\\w*)$/);
        if (slashMatch) {
            if (!folderPickerVisible) {
                if (filePickerVisible) hideFilePicker();
                if (promptPickerVisible) hidePromptPicker();
                showFolderPicker(slashMatch[1] || '');
            }
            return;
        }
        
        // Check if @ is typed at cursor position (file picker)
        const atMatch = textBeforeCursor.match(/@(\\w*)$/);
        if (atMatch) {
            if (!filePickerVisible) {
                if (promptPickerVisible) hidePromptPicker();
                if (folderPickerVisible) hideFolderPicker();
                showFilePicker();
            }
        } else {
            if (filePickerVisible) hideFilePicker();
            if (promptPickerVisible) hidePromptPicker();
            if (folderPickerVisible) hideFolderPicker();
        }
    }
    
    // Close file picker when clicking outside
    document.addEventListener('click', function(event) {
        const picker = document.getElementById('file-picker');
        const promptPicker = document.getElementById('prompt-picker');
        const input = document.getElementById('input');
        
        if (filePickerVisible && 
            !picker.contains(event.target) && 
            event.target !== input) {
            hideFilePicker();
        }
        if (promptPickerVisible && 
            !promptPicker.contains(event.target) && 
            event.target !== input) {
            hidePromptPicker();
        }
        const folderPicker = document.getElementById('folder-picker');
        if (folderPickerVisible && 
            folderPicker && !folderPicker.contains(event.target) && 
            event.target !== input) {
            hideFolderPicker();
        }
    });
    
    // =============================================
    // > Default / Saved Prompts (same format as @ and /)
    // =============================================
    function filterPrompts(search) {
        var term = (search || '').toLowerCase().trim();
        if (!term) {
            filteredPromptsForPicker = PREDEFINED_PROMPTS.slice(0);
        } else {
            filteredPromptsForPicker = PREDEFINED_PROMPTS.filter(function(p) {
                var label = (p.label || '').toLowerCase();
                var promptText = (p.prompt || '').toLowerCase();
                return label.indexOf(term) !== -1 || promptText.indexOf(term) !== -1;
            });
        }
        renderPromptList();
        selectedPromptIndex = 0;
    }
    
    function showPromptPicker(initialSearch) {
        const picker = document.getElementById('prompt-picker');
        const listEl = document.getElementById('prompt-list');
        const searchInput = document.getElementById('prompt-search');
        const input = document.getElementById('input');
        if (!picker || !listEl) return;
        promptPickerVisible = true;
        picker.classList.add('visible');
        if (searchInput) searchInput.value = initialSearch || '';
        filterPrompts(initialSearch || '');
        setTimeout(function() { if (searchInput) searchInput.focus(); }, 50);
    }
    
    function hidePromptPicker() {
        const picker = document.getElementById('prompt-picker');
        if (picker) picker.classList.remove('visible');
        promptPickerVisible = false;
        selectedPromptIndex = 0;
        const searchInput = document.getElementById('prompt-search');
        if (searchInput) searchInput.value = '';
    }
    
    function renderPromptList() {
        const listEl = document.getElementById('prompt-list');
        var prompts = filteredPromptsForPicker;  // Always set by showPromptPicker -> filterPrompts
        if (!prompts || prompts.length === 0) {
            listEl.innerHTML = '<div class="folder-picker-empty">No default prompts match</div>';
            return;
        }
        listEl.innerHTML = prompts.map(function(p, index) {
            const needsLabel = p.needsFolder ? '<span class="prompt-needs-folder">📁 pick folder</span>' : '';
            const escapedLabel = (p.label || '').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
            const escapedId = (p.id || '').replace(/'/g, '&#39;');
            const escapedPrompt = (p.prompt || '').replace(/"/g, '&quot;');
            const desc = (p.prompt || '').substring(0, 60) + (p.prompt && p.prompt.length > 60 ? '...' : '');
            return '<div class="prompt-picker-item' + (index === selectedPromptIndex ? ' selected' : '') + '" data-index="' + index + '" data-id="' + escapedId + '" data-needs-folder="' + (p.needsFolder ? '1' : '0') + '" data-prompt="' + escapedPrompt + '" onclick="selectPrompt(this)">' +
                '<span class="prompt-icon">📋</span>' +
                '<div><span class="prompt-label">' + escapedLabel + '</span><div class="prompt-desc">' + desc + '</div></div>' +
                needsLabel +
            '</div>';
        }).join('');
    }
    
    // Update the display of selected prompts (chips) - same UI as file/folder chips
    function updateSelectedPromptsDisplay() {
        const container = document.getElementById('selected-prompts');
        if (!container) return;
        container.innerHTML = selectedPrompts.map(function(p) {
            const id = (p.id || '').replace(/"/g, '&quot;');
            const label = escapeHtml(p.label || p.id || '');
            return '<div class="prompt-chip" data-id="' + id + '">' +
                '<span>📋</span>' +
                '<span class="prompt-chip-name">' + label + '</span>' +
                (p.needsFolder ? '<span class="prompt-chip-needs-folder" title="Pick a folder">📁</span>' : '') +
                '<span class="prompt-chip-remove" onclick="removeSelectedPromptFromChip(this)">&times;</span>' +
            '</div>';
        }).join('');
    }
    
    function removeSelectedPromptFromChip(el) {
        var id = el.closest('.prompt-chip').dataset.id;
        if (id) removeSelectedPrompt(id);
    }
    
    function removeSelectedPrompt(id) {
        selectedPrompts = selectedPrompts.filter(function(p) { return p.id !== id; });
        updateSelectedPromptsDisplay();
    }
    
    function selectPrompt(element) {
        const index = parseInt(element.dataset.index, 10);
        var prompts = filteredPromptsForPicker.length ? filteredPromptsForPicker : PREDEFINED_PROMPTS;
        const promptObj = prompts[index];
        if (!promptObj) return;
        const input = document.getElementById('input');
        hidePromptPicker();
        var textBefore = input.value || '';
        // Remove > and any search chars after it (same as @ and /)
        var beforeTrigger = textBefore.replace(/\\>[\\w]*$/, '');
        input.value = beforeTrigger;
        input.selectionStart = input.selectionEnd = input.value.length;
        // Add prompt as chip (same as files/folders)
        var chip = { id: promptObj.id, label: promptObj.label, prompt: promptObj.prompt, needsFolder: !!promptObj.needsFolder };
        if (!selectedPrompts.some(function(p) { return p.id === chip.id; })) {
            selectedPrompts.push(chip);
            updateSelectedPromptsDisplay();
        }
        if (promptObj.needsFolder) {
            // Add '/' to input so folder selection opens (same as typing /)
            input.value = (input.value ? input.value + ' ' : '') + '/';
            input.selectionStart = input.selectionEnd = input.value.length;
            showFolderPicker(promptObj.label);
        }
        if (input) input.focus();
    }
    
    function applyPendingPromptWithFolder(folderPath) {
        if (!pendingPromptForFolder || !folderPath) return;
        const input = document.getElementById('input');
        var replaced = pendingPromptForFolder.prompt.replace(/\\{\\{folder\\}\\}/g, folderPath);
        input.value = (input.value ? input.value + ' ' : '') + replaced;
        input.focus();
        pendingPromptForFolder = null;
    }
    
    // Scope path: when user selects a folder for a / prompt, use it as workspace for that request
    let selectedScopePath = null;
    
    // Filter folders based on search (like filterFiles)
    async function filterFolders(search) {
        const folders = await fetchWorkspaceFolders(search);
        renderFolderList(folders);
        selectedFolderIndex = 0;
    }
    
    // Update the display of selected folders (chips) - same UI as file chips
    function updateSelectedFoldersDisplay() {
        const container = document.getElementById('selected-folders');
        if (!container) return;
        container.innerHTML = selectedFolders.map(function(folder) {
            const path = (folder.path || '').replace(/"/g, '&quot;');
            const name = escapeHtml(folder.name || folder.path || '');
            return '<div class="folder-chip" data-path="' + path + '">' +
                '<span>📁</span>' +
                '<span class="folder-chip-name">' + name + '</span>' +
                '<span class="folder-chip-remove" onclick="removeSelectedFolderFromChip(this)">&times;</span>' +
            '</div>';
        }).join('');
    }
    
    function removeSelectedFolderFromChip(el) {
        var path = el.closest('.folder-chip').dataset.path;
        if (path) removeSelectedFolder(path);
    }
    
    // Remove a selected folder
    function removeSelectedFolder(path) {
        selectedFolders = selectedFolders.filter(function(f) { return f.path !== path; });
        updateSelectedFoldersDisplay();
    }
    
    // Folder picker (workspace folders only, same UI as @ file list)
    async function showFolderPicker(initialSearch) {
        const picker = document.getElementById('folder-picker');
        console.log('picker folder picker:', picker);
        console.log('initialSearch:', initialSearch);
        const listEl = document.getElementById('folder-list');
        const searchInput = document.getElementById('folder-search');
        const input = document.getElementById('input');
        if (!picker || !listEl) return;
        folderPickerVisible = true;
        picker.classList.add('visible');
        listEl.innerHTML = '<div class="folder-picker-loading">⏳ Loading folders...</div>';
        if (searchInput) searchInput.value = initialSearch || '';
        const folders = await fetchWorkspaceFolders(initialSearch || '');
        selectedFolderIndex = 0;
        renderFolderList(folders);
        setTimeout(function() { if (searchInput) searchInput.focus(); }, 50);
    }
    
    function hideFolderPicker() {
        const picker = document.getElementById('folder-picker');
        if (picker) picker.classList.remove('visible');
        folderPickerVisible = false;
        selectedFolderIndex = 0;
        const searchInput = document.getElementById('folder-search');
        if (searchInput) searchInput.value = '';
    }
    
    function escapeHtml(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    
    function renderFolderList(folders) {
        const listEl = document.getElementById('folder-list');
        if (!listEl) return;
        if (!Array.isArray(folders) || folders.length === 0) {
            listEl.innerHTML = '<div class="folder-picker-empty">No folders found</div>';
            return;
        }
        // Filter out already selected folders (same as file list)
        const filtered = folders.filter(function(f) {
            return !selectedFolders.some(function(sf) { return sf.path === f.path; });
        });
        if (filtered.length === 0) {
            listEl.innerHTML = '<div class="folder-picker-empty">All matching folders already selected</div>';
            return;
        }
        listEl.innerHTML = filtered.map(function(f, index) {
            const pathLabel = f.path === '.' ? '(workspace root)' : f.path;
            const fullPath = f.full_path || f.path || '';
            const escapedPathAttr = fullPath.replace(/"/g, '&quot;');
            const escapedName = escapeHtml(f.name || pathLabel);
            const escapedPathLabel = escapeHtml(pathLabel);
            const pathAttr = (f.path || '').replace(/"/g, '&quot;');
            return '<div class="folder-picker-item' + (index === selectedFolderIndex ? ' selected' : '') + '" data-full-path="' + escapedPathAttr + '" data-path="' + pathAttr + '" data-name="' + escapedName + '" onclick="selectFolder(this)">' +
                '<span class="file-icon">📁</span><span class="file-name">' + escapedName + '</span><span class="file-path">' + escapedPathLabel + '</span></div>';
        }).join('');
    }
    
    function selectFolder(element) {
        const path = element.dataset.path;
        const fullPath = element.dataset.fullPath;
        const name = element.dataset.name || element.getAttribute('data-name') || path || fullPath;
        const input = document.getElementById('input');
        hideFolderPicker();
        if (pendingPromptForFolder && fullPath) {
            applyPendingPromptWithFolder(fullPath);
            pendingPromptForFolder = null;
        } else {
            // Add to selected folders and show as chip (same as file selection)
            var folder = { path: path, full_path: fullPath, name: name };
            if (!selectedFolders.some(function(f) { return f.path === path; })) {
                selectedFolders.push(folder);
                updateSelectedFoldersDisplay();
            }
            // Remove / from input if present
            if (input) {
                input.value = (input.value || '').replace(/\\/$/, '');
                input.focus();
            }
        }
        // Clear folder search
        var folderSearch = document.getElementById('folder-search');
        if (folderSearch) folderSearch.value = '';
    }
    
    // When folder picker is visible, capture keydown on document so arrows/Enter work even if input lost focus (e.g. after clicking a prompt)
    document.addEventListener('keydown', function docKeydownForFolderPicker(e) {
        if (!folderPickerVisible) return;
        const items = document.querySelectorAll('.folder-picker-item');
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'ArrowDown') {
                selectedFolderIndex = Math.min(selectedFolderIndex + 1, items.length - 1);
                items.forEach(function(item, i) { item.classList.toggle('selected', i === selectedFolderIndex); });
                if (items[selectedFolderIndex]) items[selectedFolderIndex].scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'ArrowUp') {
                selectedFolderIndex = Math.max(selectedFolderIndex - 1, 0);
                items.forEach(function(item, i) { item.classList.toggle('selected', i === selectedFolderIndex); });
                if (items[selectedFolderIndex]) items[selectedFolderIndex].scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'Enter' && selectedFolderIndex >= 0 && items[selectedFolderIndex]) {
                items[selectedFolderIndex].click();
            } else if (e.key === 'Escape') {
                hideFolderPicker();
                var inp = document.getElementById('input');
                if (inp) inp.focus();
            }
        }
    }, true);
    
    // Handle input keydown for @ and / detection and navigation
    function handleInputKeyDown(event) {
        console.log('handleInputKeyDown called with event.key:', event.key);
        if (folderPickerVisible) {
            const items = document.querySelectorAll('.folder-picker-item');
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                selectedFolderIndex = Math.min(selectedFolderIndex + 1, items.length - 1);
                items.forEach(function(item, i) { item.classList.toggle('selected', i === selectedFolderIndex); });
                if (items[selectedFolderIndex]) items[selectedFolderIndex].scrollIntoView({ block: 'nearest' });
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                selectedFolderIndex = Math.max(selectedFolderIndex - 1, 0);
                items.forEach(function(item, i) { item.classList.toggle('selected', i === selectedFolderIndex); });
                if (items[selectedFolderIndex]) items[selectedFolderIndex].scrollIntoView({ block: 'nearest' });
            } else if (event.key === 'Enter' && selectedFolderIndex >= 0 && items[selectedFolderIndex]) {
                event.preventDefault();
                items[selectedFolderIndex].click();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                hideFolderPicker();
                document.getElementById('input').focus();
            }
            return;
        }
        if (promptPickerVisible) {
            console.log('promptPickerVisible is true');
            const items = document.querySelectorAll('.prompt-picker-item');
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                selectedPromptIndex = Math.min(selectedPromptIndex + 1, items.length - 1);
                items.forEach(function(item, i) { item.classList.toggle('selected', i === selectedPromptIndex); });
                if (items[selectedPromptIndex]) items[selectedPromptIndex].scrollIntoView({ block: 'nearest' });
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                selectedPromptIndex = Math.max(selectedPromptIndex - 1, 0);
                items.forEach(function(item, i) { item.classList.toggle('selected', i === selectedPromptIndex); });
                if (items[selectedPromptIndex]) items[selectedPromptIndex].scrollIntoView({ block: 'nearest' });
            } else if (event.key === 'Enter' && selectedPromptIndex >= 0 && items[selectedPromptIndex]) {
                event.preventDefault();
                items[selectedPromptIndex].click();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                hidePromptPicker();
                document.getElementById('input').focus();
            }
            return;
        }
        if (filePickerVisible) {
            console.log('filePickerVisible is true');
            const items = document.querySelectorAll('.file-picker-item');
            
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                selectedFileIndex = Math.min(selectedFileIndex + 1, items.length - 1);
                updateFileSelection(items);
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                selectedFileIndex = Math.max(selectedFileIndex - 1, 0);
                updateFileSelection(items);
            } else if (event.key === 'Enter' && selectedFileIndex >= 0) {
                event.preventDefault();
                items[selectedFileIndex].click();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                hideFilePicker();
                document.getElementById('input').focus();
            }
        } else if (event.key === 'Enter') {
            send();
        }
    }
    
    // =============================================
    
    let sessionChanges = [];  // Track all file changes in session
    
    function updateChangedFilesPanel(changes) {
        console.log('📁 updateChangedFilesPanel called with:', changes);
        sessionChanges = changes || [];
        
        const panel = document.getElementById('changed-files-panel');
        const list = document.getElementById('changed-files-list');
        const count = document.getElementById('changed-files-count');
        
        if (!panel || !list || !count) {
            console.error('❌ Changed files panel elements not found!');
            return;
        }
        
        // Filter to only show applied (not yet accepted/reverted)
        const activeChanges = sessionChanges.filter(c => c.status === 'applied');
        const allChanges = sessionChanges;
        
        console.log('📊 Total changes:', allChanges.length, 'Active:', activeChanges.length);
        
        if (allChanges.length === 0) {
            panel.style.display = 'none';
            return;
        }
        
        panel.style.display = 'block';
        count.textContent = activeChanges.length.toString();
        
        list.innerHTML = allChanges.map(function(change) {
            const isNew = change.is_new_file;
            const iconClass = isNew ? 'new' : 'modified';
            const icon = isNew ? '✚' : '✎';
            const statusClass = change.status;
            const statusText = change.status === 'applied' ? 'pending' : change.status;
            
            const isActive = change.status === 'applied';
            const itemClass = 'changed-file-item' + (change.status === 'reverted' ? ' reverted' : '') + (change.status === 'accepted' ? ' accepted' : '');
            
            // Safe escape for file paths in attributes
            const safeFilePath = (change.file_path || '').replace(/"/g, '&quot;');
            const safeFileName = (change.file_name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const safeChangeId = change.change_id || '';
            
            let actionsHtml = '';
            if (isActive) {
                actionsHtml = '<div class="changed-file-actions">' +
                    '<button class="changed-file-btn view" onclick="viewFileDiff(\\x27' + safeChangeId + '\\x27)">👁</button>' +
                    '<button class="changed-file-btn accept" onclick="acceptChange(\\x27' + safeChangeId + '\\x27)">✓</button>' +
                    '<button class="changed-file-btn revert" onclick="revertChange(\\x27' + safeChangeId + '\\x27)">↩</button>' +
                '</div>';
            }
            
            return '<div class="' + itemClass + '">' +
                '<span class="changed-file-icon ' + iconClass + '">' + icon + '</span>' +
                '<span class="changed-file-name" title="' + safeFilePath + '">' + safeFileName + '</span>' +
                '<span class="changed-file-status ' + statusClass + '">' + statusText + '</span>' +
                actionsHtml +
            '</div>';
        }).join('');
        
        console.log('✅ Changed files panel updated');
    }
    
    async function viewFileDiff(changeId) {
        try {
            // const response = await fetch(PROXY_BASE + '/applied-change/' + changeId);
            const response = await fetch('http://localhost:8000' + '/applied-change/' + changeId);
            const data = await response.json();
            
            if (data.ok) {
                // Post message to extension to open diff
                vscode.postMessage({
                    type: 'viewDiff',
                    changeId: changeId,
                    filePath: data.change.file_path,
                    oldContent: data.change.old_content,
                    newContent: data.change.new_content,
                    isNewFile: data.change.is_new_file
                });
                addTerminalOutput('📄 Opening diff: ' + data.change.file_path, 'output');
            } else {
                addTerminalOutput('❌ ' + data.message, 'error');
            }
        } catch (error) {
            addTerminalOutput('❌ Error: ' + error.message, 'error');
        }
    }
    
    async function acceptChange(changeId) {
        try {
            // const response = await fetch(PROXY_BASE + '/accept-change', {
            const response = await fetch('http://localhost:8000' + '/accept-change', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ change_id: changeId })
            });
            const data = await response.json();
            
            if (data.ok) {
                addTerminalOutput('✅ ' + data.message, 'success');
            } else {
                addTerminalOutput('❌ ' + data.message, 'error');
            }
        } catch (error) {
            addTerminalOutput('❌ Error: ' + error.message, 'error');
        }
    }
    
    async function revertChange(changeId) {
        try {
            // const response = await fetch(PROXY_BASE + '/revert-change', {
            const response = await fetch('http://localhost:8000' + '/revert-change', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ change_id: changeId })
            });
            const data = await response.json();
            
            if (data.ok) {
                addTerminalOutput('↩️ ' + data.message, 'warning');
            } else {
                addTerminalOutput('❌ ' + data.message, 'error');
            }
        } catch (error) {
            addTerminalOutput('❌ Error: ' + error.message, 'error');
        }
    }
    
    async function acceptAllChanges() {
        try {
            // const response = await fetch(PROXY_BASE + '/accept-all-changes', {
            const response = await fetch('http://localhost:8000' + '/accept-all-changes', {
                method: 'POST'
            });
            const data = await response.json();
            
            if (data.ok) {
                addTerminalOutput('✅ ' + data.message, 'success');
            } else {
                addTerminalOutput('❌ ' + data.message, 'error');
            }
        } catch (error) {
            addTerminalOutput('❌ Error: ' + error.message, 'error');
        }
    }
    
    async function revertAllChanges() {
        try {
            // const response = await fetch(PROXY_BASE + '/revert-all-changes', {
            const response = await fetch('http://localhost:8000' + '/revert-all-changes', {
                method: 'POST'
            });
            const data = await response.json();
            
            if (data.ok) {
                addTerminalOutput('↩️ ' + data.message, 'warning');
                if (data.errors && data.errors.length > 0) {
                    addTerminalOutput('⚠️ Errors: ' + data.errors.join(', '), 'error');
                }
            } else {
                addTerminalOutput('❌ ' + data.message, 'error');
            }
        } catch (error) {
            addTerminalOutput('❌ Error: ' + error.message, 'error');
        }
    }
    
    async function clearChangedFiles() {
        try {
            // await fetch(PROXY_BASE + '/clear-session-changes', {
            await fetch('http://localhost:8000' + '/clear-session-changes', {
                method: 'POST'
            });
            sessionChanges = [];
            updateChangedFilesPanel([]);
            addTerminalOutput('🗑️ Cleared changed files list', 'output');
        } catch (error) {
            addTerminalOutput('❌ Error: ' + error.message, 'error');
        }
    }
    
    // Make functions global
    window.viewFileDiff = viewFileDiff;
    window.acceptChange = acceptChange;
    window.revertChange = revertChange;
    window.acceptAllChanges = acceptAllChanges;
    window.revertAllChanges = revertAllChanges;
    window.clearChangedFiles = clearChangedFiles;
    
    // =============================================
    // Progress Panel Functions
    // =============================================
    
    function handleProgressUpdate(data) {
        const progressPanel = document.getElementById('progress-panel');
        const progressTasks = document.getElementById('progress-tasks');
        
        if (data.action === 'start_session') {
            // Show progress panel and clear tasks
            progressPanel.classList.add('visible');
            progressTasks.innerHTML = '';
        } else if (data.action === 'end_session') {
            // Hide progress panel after a short delay
            setTimeout(function() {
                progressPanel.classList.remove('visible');
            }, 1500);
        } else if (data.action === 'add_task' || data.action === 'update_task') {
            // Update task list
            renderProgressTasks(data.tasks || []);
        }
    }
    
    function renderProgressTasks(tasks) {
        const progressTasks = document.getElementById('progress-tasks');
        
        progressTasks.innerHTML = tasks.map(function(task) {
            const iconHtml = getTaskIcon(task.status);
            const nameClass = task.status === 'completed' ? 'progress-task-name completed' : 'progress-task-name';
            
            return '<li class="progress-task">' +
                '<span class="progress-task-icon ' + task.status + '">' + iconHtml + '</span>' +
                '<div class="progress-task-content">' +
                    '<div class="' + nameClass + '">' + escapeHtml(task.name) + '</div>' +
                    (task.details ? '<div class="progress-task-details">' + escapeHtml(task.details) + '</div>' : '') +
                '</div>' +
            '</li>';
        }).join('');
        
        // Auto-scroll to show latest task
        progressTasks.scrollTop = progressTasks.scrollHeight;
    }
    
    function getTaskIcon(status) {
        switch(status) {
            case 'pending':
                return '○';
            case 'in_progress':
                return '<div class="task-mini-spinner"></div>';
            case 'completed':
                return '✓';
            case 'error':
                return '✗';
            default:
                return '○';
        }
    }
    
    // =============================================
    // Process control functions
    // =============================================
    
    function showProcessControls(processId) {
        currentProcessId = processId;
        const controls = document.getElementById('process-controls');
        const display = document.getElementById('process-id-display');
        if (controls && display) {
            display.textContent = processId;
            controls.style.display = 'block';
            document.getElementById('process-input').focus();
        }
    }
    
    function hideProcessControls() {
        const controls = document.getElementById('process-controls');
        if (controls) {
            controls.style.display = 'none';
        }
        currentProcessId = null;
    }
    
    async function sendProcessInput() {
        if (!currentProcessId) {
            addTerminalOutput('❌ No active process', 'error');
            return;
        }
        
        const input = document.getElementById('process-input');
        const inputText = input.value.trim();
        
        if (!inputText) {
            return;
        }
        
        try {
            addTerminalOutput('📥 Sending: ' + inputText, 'warning');
            
            // const response = await fetch(PROXY_BASE + '/send-input/' + currentProcessId, {
            const response = await fetch('http://localhost:8000' + '/send-input/' + currentProcessId, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ input_text: inputText })
            });
            
            const data = await response.json();
            
            if (data.ok) {
                input.value = '';
            } else {
                addTerminalOutput('❌ ' + (data.message || 'Failed to send input'), 'error');
            }
        } catch (error) {
            addTerminalOutput('❌ Error: ' + error.message, 'error');
        }
    }
    
    async function killProcess() {
        if (!currentProcessId) {
            addTerminalOutput('❌ No active process to kill', 'error');
            return;
        }
        
        try {
            addTerminalOutput('🛑 Terminating process ' + currentProcessId + '...', 'warning');
            
            // const response = await fetch(PROXY_BASE + '/kill-process/' + currentProcessId, {
            const response = await fetch('http://localhost:8000' + '/kill-process/' + currentProcessId, {
                method: 'POST'
            });
            
            const data = await response.json();
            
            if (data.ok) {
                addTerminalOutput('✅ Process terminated', 'success');
                hideProcessControls();
            } else {
                addTerminalOutput('❌ ' + (data.message || 'Failed to kill process'), 'error');
            }
        } catch (error) {
            addTerminalOutput('❌ Error: ' + error.message, 'error');
        }
    }

    function connectWebSocket() {
        // socket = new WebSocket(WS_BASE + '/ws/logs');
        socket = new WebSocket('ws://localhost:8000' + '/ws/logs');

    socket.onopen = () => {
        console.log('✅ WebSocket connected');
        statusDiv.textContent = '🟢 Connected';
        statusDiv.className = 'status status-connected';
        reconnectAttempts = 0;
        addTerminalOutput('✅ Agent terminal connected', 'success');
        
        // Fetch any existing session changes
        fetchSessionChanges();
    };
    
    // Fetch existing session changes from server
    async function fetchSessionChanges() {
        try {
            // const response = await fetch(PROXY_BASE + '/session-changes');
            const response = await fetch('http://localhost:8000' + '/session-changes');
            const data = await response.json();
            if (data.ok && data.changes && data.changes.length > 0) {
                console.log('📂 Loaded existing session changes:', data.changes.length);
                updateChangedFilesPanel(data.changes);
            }
        } catch (error) {
            console.log('Could not fetch session changes:', error);
        }
    }

    socket.onerror = (e) => {
        console.error('❌ WebSocket error', e);
            statusDiv.textContent = '🔴 Connection error';
            statusDiv.className = 'status status-disconnected';
            addTerminalOutput('❌ WebSocket error - make sure server is running on port 8000', 'error');
    };

    socket.onclose = () => {
        console.log('❌ WebSocket closed');
            statusDiv.textContent = '🔴 Disconnected';
            statusDiv.className = 'status status-disconnected';
            addTerminalOutput('⚠️ Connection closed. Reconnecting...', 'warning');
            
            // Auto-reconnect
            if (reconnectAttempts < 5) {
                reconnectAttempts++;
                setTimeout(connectWebSocket, 2000);
            }
    };

    socket.onmessage = (event) => {
        console.log('📨 WebSocket message received:', event.data);
        try {
        const data = JSON.parse(event.data);
            console.log('📦 Parsed data:', data);
            console.log('🔍 Message type:', data.type);

        if (data.type === 'log') {
                const content = data.content;
                
                // Parse different log types for better formatting
                if (content.startsWith('▶️ Executing:')) {
                    const command = content.replace('▶️ Executing:', '').trim();
                    addTerminalCommand(command);
                } else if (content.startsWith('✅')) {
                    addTerminalOutput(content, 'success');
                } else if (content.startsWith('❌')) {
                    addTerminalOutput(content, 'error');
                } else if (content.startsWith('⚠️')) {
                    addTerminalOutput(content, 'warning');
                } else if (content.startsWith('📖 Reading:') || content.startsWith('✓ Read:')) {
                    // File read operation
                    addFileOperation(content, 'read');
                } else if (content.startsWith('✏️ Editing:') || content.startsWith('📄 Creating:')) {
                    // File write operation starting
                    addFileOperation(content, 'write');
                } else if (content.startsWith('✅ Edited:') || content.startsWith('✅ Created:')) {
                    // File write operation completed
                    addFileOperation(content, 'done');
                } else if (content.includes('🤖 Agent:')) {
                    addTerminalOutput(content, 'output');
                } else if (content.trim() && !content.startsWith('💡')) {
                    // Regular output (command stdout)
                    addTerminalOutput(content, 'output');
                }
            } else if (data.type === 'file_change') {
                console.log('🔥 FILE CHANGE MESSAGE RECEIVED!');
                console.log('   Full data:', JSON.stringify(data, null, 2));
                console.log('   Change ID:', data.change_id);
                console.log('   File path:', data.file_path);
                console.log('   Is new file:', data.is_new_file);
                console.log('   Has diff:', !!data.diff);
                console.log('   Has preview:', !!data.preview);
                
                // Add visible notification in terminal
                addTerminalOutput('🔔 File change notification received!', 'warning');
                
                // Show in terminal with accept/reject buttons
                console.log('🎨 About to call showFileDiff...');
                try {
                    showFileDiff(data.change_id, data.file_path, data.diff, data.is_new_file, data.preview);
                    console.log('✅ showFileDiff executed successfully');
                } catch (err) {
                    console.error('❌ showFileDiff error:', err);
                    addTerminalOutput('❌ Error showing diff: ' + err.message, 'error');
                }
            } else if (data.type === 'process_start') {
                // Process started - show input controls
                console.log('🚀 Process started:', data.process_id);
                addTerminalOutput('🚀 Process started (ID: ' + data.process_id + ')', 'warning');
                addTerminalOutput('💡 Use the input field below to send input, or click Kill to stop', 'output');
                showProcessControls(data.process_id);
            } else if (data.type === 'process_end') {
                // Process ended - hide input controls
                console.log('🏁 Process ended:', data.process_id);
                hideProcessControls();
            } else if (data.type === 'progress') {
                // Handle progress updates
                console.log('📊 Progress update:', data.action, data.tasks);
                handleProgressUpdate(data);
            } else if (data.type === 'file_applied') {
                // Handle applied file changes (new workflow)
                console.log('📝 FILE_APPLIED received:', data);
                console.log('   File path:', data.file_path);
                console.log('   All changes:', data.all_changes);
                addTerminalOutput('✅ File updated: ' + data.file_path, 'success');
                
                // Update the changed files panel
                if (data.all_changes) {
                    console.log('🔄 Calling updateChangedFilesPanel with', data.all_changes.length, 'changes');
                    updateChangedFilesPanel(data.all_changes);
                } else {
                    console.warn('⚠️ No all_changes in file_applied message');
                }
            } else if (data.type === 'session_changes_update') {
                // Handle session changes update (after accept/revert)
                console.log('📁 SESSION_CHANGES_UPDATE received:', data.changes);
                updateChangedFilesPanel(data.changes);
            } else {
                console.log('⚠️ Unknown message type:', data.type);
            }
        } catch (error) {
            console.error('❌ Error parsing WebSocket message:', error);
            addTerminalOutput('❌ Error: ' + error.message, 'error');
        }
    };
    }

    function addTerminalLine(text, color = '#cccccc') {
        const line = document.createElement('div');
        line.className = 'terminal-line';
        line.style.color = color;
        line.textContent = text;
        terminalContainer.appendChild(line);
        terminalContainer.scrollTop = terminalContainer.scrollHeight;
    }

    function addTerminalCommand(command) {
        const line = document.createElement('div');
        line.className = 'terminal-line';
        line.innerHTML = '<span class="terminal-prompt">agent@neuralstack:~$</span> <span class="terminal-command">' + command + '</span>';
        terminalContainer.appendChild(line);
        terminalContainer.scrollTop = terminalContainer.scrollHeight;
    }

    function addTerminalOutput(output, type = 'output') {
        const line = document.createElement('div');
        line.className = 'terminal-line terminal-' + type;
        line.textContent = output;
        terminalContainer.appendChild(line);
        terminalContainer.scrollTop = terminalContainer.scrollHeight;
    }
    
    function addFileOperation(message, type) {
        const line = document.createElement('div');
        line.className = 'file-operation ' + type;
        line.textContent = message;
        terminalContainer.appendChild(line);
        terminalContainer.scrollTop = terminalContainer.scrollHeight;
    }

    let pendingConfirmation = null;

    function showConfirmationButtons(message, command) {
        // Remove any existing confirmation boxes
        const existing = terminalContainer.querySelector('.confirmation-box');
        if (existing) existing.remove();

        const confirmBox = document.createElement('div');
        confirmBox.className = 'confirmation-box';
        
        confirmBox.innerHTML = \`
            <div class="confirmation-message">⚠️ Command Execution Confirmation</div>
            <div>\${message}</div>
            <div class="confirmation-command">\$ \${command}</div>
            <div class="confirmation-buttons">
                <button class="confirm-btn confirm-btn-yes" onclick="handleConfirmation(true)">
                    ✓ Yes, Execute
                </button>
                <button class="confirm-btn confirm-btn-no" onclick="handleConfirmation(false)">
                    ✗ No, Cancel
                </button>
            </div>
        \`;
        
        terminalContainer.appendChild(confirmBox);
        terminalContainer.scrollTop = terminalContainer.scrollHeight;
    }

    // Make file picker and prompt picker functions global for onclick handlers
    window.selectFile = selectFile;
    window.selectPrompt = selectPrompt;
    window.selectFolder = selectFolder;
    window.removeSelectedFile = removeSelectedFile;
    window.filterFiles = filterFiles;
    window.handleInputKeyDown = handleInputKeyDown;
    window.handleInputChange = handleInputChange;

    window.handleConfirmation = function(approved) {
        const confirmBox = terminalContainer.querySelector('.confirmation-box');
        if (confirmBox) {
            confirmBox.remove();
        }

        if (pendingConfirmation) {
            const response = approved ? 'yes' : 'no';
            
            if (approved) {
                addTerminalOutput('✓ User approved execution', 'success');
            } else {
                addTerminalOutput('✗ User cancelled execution', 'error');
            }

            // Send the confirmation response
            const input = document.getElementById('input');
            input.value = response;
            send();
            pendingConfirmation = null;
        }
    };

    function showFileDiff(changeId, filePath, diff, isNewFile, preview) {
        console.log('🎨 showFileDiff called with:', {changeId, filePath, isNewFile});
        
        // Check if this change ID already exists
        const selector = '[data-change-id="' + changeId + '"]';
        const existingForThisChange = terminalContainer.querySelector(selector);
        if (existingForThisChange) {
            console.log('⚠️ Diff already displayed for change:', changeId);
            return;
        }

        console.log('📦 Creating compact diff notification...');
        const diffBox = document.createElement('div');
        diffBox.className = 'file-diff-box';
        diffBox.setAttribute('data-change-id', changeId);
        
        const badge = isNewFile ? '<span style="color: #00ff00;">●</span> NEW FILE' : '<span style="color: #ffa500;">●</span> EDIT';
        
        // Compact view - just show file name and action buttons
        diffBox.innerHTML = \`
            <div class="diff-compact">
                <div class="diff-compact-header">
                    <span class="diff-icon">📝</span>
                    <span class="diff-file-name">\${filePath}</span>
                    <span class="diff-badge">\${badge}</span>
                </div>
                <div class="diff-compact-actions">
                    <button class="diff-btn-compact diff-btn-view" onclick="viewDiffInEditor('\${changeId}', '\${filePath}')">
                        👁️ View Diff
                    </button>
                    <button class="diff-btn-compact diff-btn-accept" onclick="handleFileDiff('\${changeId}', true)">
                        ✓ Accept
                    </button>
                    <button class="diff-btn-compact diff-btn-reject" onclick="handleFileDiff('\${changeId}', false)">
                        ✗ Reject
                    </button>
                </div>
            </div>
        \`;
        
        console.log('➕ Appending compact diff notification to terminal');
        terminalContainer.appendChild(diffBox);
        terminalContainer.scrollTop = terminalContainer.scrollHeight;
        console.log('✅ Compact diff notification added');
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Store file change data for viewing in editor
    window.fileChanges = window.fileChanges || {};
    
    window.viewDiffInEditor = function(changeId, filePath) {
        console.log('👁️ Opening diff in editor for:', filePath);
        
        // Send message to VS Code extension to open diff
        vscode.postMessage({
            type: 'viewDiff',
            changeId: changeId,
            filePath: filePath
        });
        
        addTerminalOutput('📄 Opening diff in editor: ' + filePath, 'output');
    };

    window.handleFileDiff = async function(changeId, approved) {
        // Remove only THIS specific diff box
        const selector = '[data-change-id="' + changeId + '"]';
        const diffBox = terminalContainer.querySelector(selector);
        if (diffBox) {
            diffBox.remove();
            console.log('🗑️ Removed diff box for change:', changeId);
        }

        try {
            // const response = await fetch(PROXY_BASE + '/approve-file-change', {
            const response = await fetch('http://localhost:8000' + '/approve-file-change', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ 
                    change_id: changeId,
                    approved: approved
                })
            });
            
            const data = await response.json();
            
            if (data.ok) {
                if (approved) {
                    addTerminalOutput(\`✅ Changes applied to: \${data.file_path}\`, 'success');
                } else {
                    addTerminalOutput(\`❌ Changes rejected for: \${data.file_path}\`, 'error');
                }
            } else {
                addTerminalOutput(\`❌ Error: \${data.message}\`, 'error');
            }
        } catch (error) {
            addTerminalOutput(\`❌ Error processing file change: \${error.message}\`, 'error');
        }
    };

    // Parse options from agent response
    function parseAgentOptions(text) {
        const options = [];
        
        // Pattern 1: Numbered options (1. Option, 2. Option, etc.)
        const numberedPattern = /^\\s*(?:\\d+[.\\):]|[-•*])\\s*(.+)$/gm;
        let match;
        while ((match = numberedPattern.exec(text)) !== null) {
            const option = match[1].trim();
            // Skip if it looks like code or a path
            if (option && !option.startsWith('/') && option.length < 100) {
                options.push(option);
            }
        }
        
        // Pattern 2: "yes/no" type questions
        if (text.toLowerCase().includes('(yes/no)') || 
            text.toLowerCase().includes('yes or no') ||
            text.toLowerCase().includes('should i proceed')) {
            if (!options.includes('Yes') && !options.includes('yes')) {
                options.push('Yes');
                options.push('No');
            }
        }
        
        // Limit to reasonable number
        return options.slice(0, 6);
    }
    
    // Check if agent is asking a question
    function isAgentAskingQuestion(text) {
        const questionIndicators = [
            '?',
            'would you like',
            'do you want',
            'should i',
            'which one',
            'please choose',
            'please select',
            'options:',
            'what would you',
            'let me know',
            'tell me which'
        ];
        
        const lowerText = text.toLowerCase();
        return questionIndicators.some(indicator => lowerText.includes(indicator));
    }
    
    // Send option as user response
    function sendOptionResponse(option) {
        const input = document.getElementById('input');
        input.value = option;
        send();
    }

    function addChatMessage(sender, text, isUser = false) {
        const msg = document.createElement('div');
        msg.className = 'chat-message ' + (isUser ? 'user-message' : 'agent-message');
        
        // For agent messages, check if there are options to display
        if (!isUser && isAgentAskingQuestion(text)) {
            const options = parseAgentOptions(text);
            
            if (options.length > 0) {
                // Create message with options buttons
                const escapedText = escapeHtml(text).replace(/\\n/g, '<br>');
                let html = '<strong>' + sender + ':</strong> ' + escapedText;
                html += '<div class="quick-reply-container">';
                html += '<span class="quick-reply-label">💡 Quick replies:</span>';
                html += '<div class="agent-options">';
                
                options.forEach(function(opt, i) {
                    const escapedOpt = escapeHtml(opt);
                    const safeOpt = escapedOpt.replace(/'/g, '&#39;');
                    const btnClass = i === 0 ? 'option-btn primary' : 'option-btn';
                    html += '<button class="' + btnClass + '" onclick="sendOptionResponse(\\'' + safeOpt + '\\')">' + escapedOpt + '</button>';
                });
                
                html += '</div></div>';
                msg.innerHTML = html;
            } else {
                msg.innerHTML = '<strong>' + sender + ':</strong> ' + escapeHtml(text).replace(/\\n/g, '<br>');
            }
        } else {
            msg.innerHTML = '<strong>' + sender + ':</strong> ' + escapeHtml(text).replace(/\\n/g, '<br>');
        }
        
        chatContainer.appendChild(msg);
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }
    
    // Make sendOptionResponse available globally
    window.sendOptionResponse = sendOptionResponse;

    async function send() {
        const input = document.getElementById('input');
        const text = input.value.trim();
        
        if (!text && selectedPrompts.length === 0) return;

        // Build message with file context and selected prompts
        let messageWithContext = text;
        
        // If files are selected, include them in the message
        if (selectedFiles.length > 0) {
            const fileContexts = [];
            
            // Show that we're loading file contents
            addTerminalOutput('📂 Reading selected files...', 'warning');
            
            for (const file of selectedFiles) {
                try {
                    // const response = await fetch(PROXY_BASE + '/read-file-content', {
                    const response = await fetch('http://localhost:8000' + '/read-file-content', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            path: file.path,
                            workspace_path: workspacePath
                        })
                    });
                    const data = await response.json();
                    if (data.ok) {
                        fileContexts.push(\`
📄 File: \${file.path}
\\\`\\\`\\\`
\${data.content}
\\\`\\\`\\\`
\`);
                        addTerminalOutput('✓ Loaded: ' + file.path, 'success');
                    }
                } catch (e) {
                    console.error('Error reading file:', file.path, e);
                }
            }
            
            if (fileContexts.length > 0) {
                messageWithContext = \`The user has attached the following files for context:
\${fileContexts.join('\\n')}

User's question: \${text}\`;
            }
        }
        
        // If prompts are selected, resolve {{folder}} and prepend to message
        if (selectedPrompts.length > 0) {
            const folderPath = selectedFolders.length > 0 ? selectedFolders[0].full_path : '';
            const resolvedPrompts = selectedPrompts.map(function(p) {
                var t = p.prompt;
                if (p.needsFolder && folderPath) t = t.replace(/\\{\\{folder\\}\\}/g, folderPath);
                return t;
            });
            const promptContext = 'The user has selected the following prompts:\\n\\n' + resolvedPrompts.join('\\n\\n');
            messageWithContext = promptContext + (messageWithContext ? '\\n\\nUser\\'s question: ' + messageWithContext : '');
        }
        
        // Display original message in chat (files, folders, and prompts as chips)
        let displayMessage = text;
        if (selectedFiles.length > 0 || selectedFolders.length > 0 || selectedPrompts.length > 0) {
            const filePart = selectedFiles.length > 0 ? ' [📎 ' + selectedFiles.map(f => f.name).join(', ') + ']' : '';
            const folderPart = selectedFolders.length > 0 ? ' [📁 ' + selectedFolders.map(f => f.name).join(', ') + ']' : '';
            const promptPart = selectedPrompts.length > 0 ? ' [📋 ' + selectedPrompts.map(p => p.label).join(', ') + ']' : '';
            displayMessage = text + filePart + folderPart + promptPart;
        }
        
        addChatMessage('You', displayMessage, true);
        
        // Scope for this request (first selected folder or folder from / prompt)
        const scopePath = selectedScopePath || (selectedFolders.length > 0 ? selectedFolders[0].full_path : null);
        
        // Clear selected files, folders, and prompts
        selectedFiles = [];
        updateSelectedFilesDisplay();
        selectedFolders = [];
        updateSelectedFoldersDisplay();
        selectedPrompts = [];
        updateSelectedPromptsDisplay();

        input.value = '';
        input.disabled = true;
        agentRequestInProgress = true;
        const stopBtn = document.getElementById('stop-agent-btn');
        const sendBtn = document.getElementById('send-btn');
        if (stopBtn) stopBtn.style.display = '';
        if (sendBtn) sendBtn.style.display = 'none';

        try {
            addTerminalOutput('⚙️ Agent processing request...', 'warning');
            const requestBody = { 
                message: messageWithContext,
                workspace_path: scopePath || workspacePath
            };
            if (scopePath) {
                requestBody.scope_path = scopePath;
            }
            if (sessionId) {
                requestBody.session_id = sessionId;
            }
            selectedScopePath = null;

        // const response = await fetch(PROXY_BASE + '/chat', {
        const response = await fetch('http://localhost:8000' + '/chat', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(requestBody)
        });
            
            if (!response.ok) {
                throw new Error('Server error: ' + response.status);
            }
        
        const data = await response.json();
            
            // Store session ID from response
            if (data.session_id) {
                if (!sessionId) {
                    addTerminalOutput('📝 Chat session started: ' + data.session_id.substring(0, 8) + '...', 'output');
                }
                sessionId = data.session_id;
                currentSessionTitle = data.session_title || currentSessionTitle;
                updateSessionTitle();
            }
            
            // Check if agent is asking for confirmation
            const responseText = data.response || '';
            const isConfirmationRequest = 
                responseText.toLowerCase().includes('should i proceed') ||
                responseText.toLowerCase().includes('do you want me to') ||
                responseText.toLowerCase().includes('may i') ||
                responseText.toLowerCase().includes('(yes/no)');
            
            if (isConfirmationRequest) {
                // Extract command from response if possible
                const commandMatch = responseText.match(/\`([^\`]+)\`/);
                const command = commandMatch ? commandMatch[1] : 'unknown command';
                
                // Show in chat
                addChatMessage('Agent ⚠️', data.response, false);
                
                // Show interactive confirmation in terminal
                showConfirmationButtons('The agent wants to execute this command:', command);
                pendingConfirmation = command;
            } else {
                addChatMessage('Agent', data.response, false);
                addTerminalOutput('✅ Agent response received', 'success');
            }
        } catch (error) {
            addChatMessage('System', 'Error: ' + error.message, false);
            addTerminalOutput('❌ Error: ' + error.message, 'error');
        } finally {
            agentRequestInProgress = false;
            const stopBtn = document.getElementById('stop-agent-btn');
            const sendBtn = document.getElementById('send-btn');
            if (stopBtn) stopBtn.style.display = 'none';
            if (sendBtn) sendBtn.style.display = '';
            input.disabled = false;
            input.focus();
        }
    }

    window.stopAgent = async function stopAgent() {
        const btn = document.getElementById('stop-agent-btn');
        if (btn) btn.disabled = true;
        try {
            const body = sessionId ? { session_id: sessionId } : {};
            const response = await fetch('http://localhost:8000' + '/stop-agent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = response.ok ? await response.json() : {};
            if (data.ok) {
                addTerminalOutput('⏹️ Stop requested. Agent will stop after current step.', 'warning');
            } else {
                addTerminalOutput('❌ ' + (data.message || 'Failed to request stop'), 'error');
            }
        } catch (error) {
            addTerminalOutput('❌ Error requesting stop: ' + error.message, 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    };

    function updateSessionTitle() {
        const titleEl = document.getElementById('session-title');
        if (titleEl) {
            titleEl.textContent = '💬 ' + currentSessionTitle;
        }
    }

    // Add function to clear chat history
    async function clearHistory() {
        if (!sessionId) return;
        
        try {
            // await fetch(PROXY_BASE + '/clear-history', {
            await fetch('http://localhost:8000' + '/clear-history', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ session_id: sessionId })
            });
            
            chatContainer.innerHTML = '';
            addTerminalOutput('🗑️ Chat history cleared', 'warning');
        } catch (error) {
            addTerminalOutput('❌ Failed to clear history: ' + error.message, 'error');
        }
    }

    async function newChat() {
        sessionId = null;
        currentSessionTitle = "New Chat";
        chatContainer.innerHTML = '';
        updateSessionTitle();
        addTerminalOutput('✨ Started new chat session', 'success');
    }

    async function showSessions() {
        try {
            // const response = await fetch(PROXY_BASE + '/sessions');
            const response = await fetch('http://localhost:8000' + '/sessions');
            const data = await response.json();
            
            if (!data.ok) {
                addTerminalOutput('❌ Failed to load sessions', 'error');
                return;
            }

            const modal = document.getElementById('sessions-modal');
            const sessionsList = document.getElementById('sessions-list');
            
            if (data.sessions.length === 0) {
                sessionsList.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--vscode-descriptionForeground);">No chat history yet</div>';
            } else {
                sessionsList.innerHTML = data.sessions.map(session => \`
                    <div class="session-item" onclick="loadSession('\${session.id}')">
                        <span class="session-item-delete" onclick="event.stopPropagation(); deleteSession('\${session.id}')">&times;</span>
                        <div class="session-item-title">\${escapeHtml(session.title)}</div>
                        <div class="session-item-meta">
                            \${session.message_count} messages • \${formatDate(session.updated_at)}
                        </div>
                    </div>
                \`).join('');
            }
            
            modal.style.display = 'block';
        } catch (error) {
            addTerminalOutput('❌ Error loading sessions: ' + error.message, 'error');
        }
    }

    function closeSessions() {
        const modal = document.getElementById('sessions-modal');
        modal.style.display = 'none';
    }

    async function loadSession(sid) {
        try {
            // const response = await fetch(\`\${PROXY_BASE}/session/\${sid}\`);
            const response = await fetch(\`http://localhost:8000/session/\${sid}\`);
        const data = await response.json();
            
            if (!data.ok) {
                addTerminalOutput('❌ Failed to load session', 'error');
                return;
            }

            sessionId = sid;
            currentSessionTitle = data.session.title;
            updateSessionTitle();
            
            chatContainer.innerHTML = '';
            data.session.messages.forEach(msg => {
                addChatMessage(
                    msg.role === 'user' ? 'You' : 'Agent',
                    msg.content,
                    msg.role === 'user'
                );
            });
            
            closeSessions();
            addTerminalOutput('📂 Loaded session: ' + currentSessionTitle, 'success');
        } catch (error) {
            addTerminalOutput('❌ Error loading session: ' + error.message, 'error');
        }
    }

    async function deleteSession(sid) {
        if (!confirm('Delete this chat session?')) return;
        
        try {
            // await fetch(\`\${PROXY_BASE}/session/\${sid}\`, {
            await fetch(\`http://localhost:8000/session/\${sid}\`, {
                method: 'DELETE'
            });
            
            if (sid === sessionId) {
                newChat();
            }
            
            showSessions(); // Refresh list
        } catch (error) {
            addTerminalOutput('❌ Error deleting session: ' + error.message, 'error');
        }
    }

    function formatDate(dateStr) {
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        
        if (diffMins < 1) return 'just now';
        if (diffMins < 60) return \`\${diffMins}m ago\`;
        
        const diffHours = Math.floor(diffMins / 60);
        if (diffHours < 24) return \`\${diffHours}h ago\`;
        
        const diffDays = Math.floor(diffHours / 24);
        if (diffDays < 7) return \`\${diffDays}d ago\`;
        
        return date.toLocaleDateString();
    }

    // Close modal when clicking outside
    window.onclick = function(event) {
        const modal = document.getElementById('sessions-modal');
        if (event.target === modal) {
            closeSessions();
        }
    };

    // Initialize WebSocket connection
    connectWebSocket();
</script>
            </body>
            </html>
        `;
    }
}