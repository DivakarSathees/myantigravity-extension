import * as vscode from 'vscode';

let currentDiffEditor: vscode.TextEditor | undefined;
let pendingChanges: Map<string, any> = new Map();

export function activate(context: vscode.ExtensionContext) {
    const provider = new AntigravityViewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('antigravity.chatView', provider)
    );

    // Command to accept file changes
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.acceptChange', async (changeId: string) => {
            try {
                const response = await fetch('http://localhost:8000/approve-file-change', {
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
        vscode.commands.registerCommand('antigravity.rejectChange', async (changeId: string) => {
            try {
                const response = await fetch('http://localhost:8000/approve-file-change', {
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
        const { change_id, file_path, diff, is_new_file, preview } = changeData;
        
        // Store change data
        pendingChanges.set(change_id, changeData);

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        const filePath = vscode.Uri.file(file_path.startsWith('/') ? file_path : `${workspaceFolder.uri.fsPath}/${file_path}`);
        
        if (is_new_file) {
            // For new files, show the content in a new editor
            const doc = await vscode.workspace.openTextDocument({
                content: preview || '',
                language: file_path.endsWith('.py') ? 'python' : 
                         file_path.endsWith('.js') ? 'javascript' :
                         file_path.endsWith('.ts') ? 'typescript' : 'plaintext'
            });
            currentDiffEditor = await vscode.window.showTextDocument(doc, {
                preview: true,
                viewColumn: vscode.ViewColumn.One
            });
            
            // Show info message with buttons
            const result = await vscode.window.showInformationMessage(
                `📝 New file proposed: ${file_path}`,
                { modal: true },
                'Accept',
                'Reject'
            );
            
            if (result === 'Accept') {
                await vscode.commands.executeCommand('antigravity.acceptChange', change_id);
            } else if (result === 'Reject') {
                await vscode.commands.executeCommand('antigravity.rejectChange', change_id);
            }
        } else {
            // For existing files, show diff
            // Get original content from server
            const response = await fetch(`http://localhost:8000/get-file-content?path=${encodeURIComponent(file_path)}`);
            const data: any = await response.json();
            const originalContent = data.content || '';
            const newContent = changeData.new_content || '';

            // Create temporary files for diff
            const originalUri = vscode.Uri.parse(`untitled:${file_path}.original`);
            const modifiedUri = vscode.Uri.parse(`untitled:${file_path}.modified`);

            // Write content to workspace
            await vscode.workspace.fs.writeFile(
                originalUri,
                Buffer.from(originalContent)
            );
            await vscode.workspace.fs.writeFile(
                modifiedUri,
                Buffer.from(newContent)
            );

            // Open diff editor
            await vscode.commands.executeCommand(
                'vscode.diff',
                originalUri,
                modifiedUri,
                `${file_path} (Changes)`,
                { preview: false }
            );

            // Show action buttons
            const result = await vscode.window.showInformationMessage(
                `📝 File changes proposed for: ${file_path}`,
                { modal: true },
                'Accept',
                'Reject'
            );
            
            if (result === 'Accept') {
                await vscode.commands.executeCommand('antigravity.acceptChange', change_id);
            } else if (result === 'Reject') {
                await vscode.commands.executeCommand('antigravity.rejectChange', change_id);
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
                    connect-src http://localhost:8000 ws://localhost:8000;
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
                    border: 2px solid var(--vscode-terminal-ansiBrightCyan);
                    padding: 12px;
                    margin: 10px 0;
                    border-radius: 4px;
                    max-height: 400px;
                    overflow-y: auto;
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
                .input-container {
                    display: flex;
                    gap: 5px;
                }
                #input {
                    flex: 1;
                    padding: 6px;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 2px;
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
            </style>
            </head>
            <body>
                <h3>🚀 MyAntigravity Agent</h3>
                
                <div class="section">
                    <div class="section-title">
                        Chat Sessions
                        <button onclick="showSessions()" style="float: right; font-size: 10px; padding: 2px 6px; margin-left: 5px;">History</button>
                        <button onclick="newChat()" style="float: right; font-size: 10px; padding: 2px 6px; margin-left: 5px;">New Chat</button>
                        <button onclick="clearHistory()" style="float: right; font-size: 10px; padding: 2px 6px;">Clear</button>
                    </div>
                    <div id="session-title" style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 5px; padding: 3px;"></div>
                    <div id="chat"></div>
                    <div class="input-container">
                        <input id="input" type="text" placeholder="Ask agent to build..." onkeypress="if(event.key==='Enter') send()">
                        <button onclick="send()">Send</button>
                    </div>
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

                <div class="section">
                    <div class="section-title">Terminal Output</div>
                    <div id="status" class="status status-disconnected">⚪ Connecting...</div>
                    <div id="terminal"></div>
                </div>

                <script>
    const vscode = acquireVsCodeApi();
    const chatContainer = document.getElementById('chat');
    const terminalContainer = document.getElementById('terminal');
    const statusDiv = document.getElementById('status');

    let socket = null;
    let reconnectAttempts = 0;
    let sessionId = null;  // Store session ID for chat history
    let currentSessionTitle = "New Chat";

    function connectWebSocket() {
        socket = new WebSocket('ws://localhost:8000/ws/logs');

    socket.onopen = () => {
        console.log('✅ WebSocket connected');
        statusDiv.textContent = '🟢 Connected';
        statusDiv.className = 'status status-connected';
        reconnectAttempts = 0;
        addTerminalOutput('✅ Agent terminal connected', 'success');
    };

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
        line.innerHTML = '<span class="terminal-prompt">agent@antigravity:~$</span> <span class="terminal-command">' + command + '</span>';
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
        
        // Remove any existing diff boxes
        const existing = terminalContainer.querySelectorAll('.file-diff-box');
        console.log('🗑️ Removing', existing.length, 'existing diff boxes');
        existing.forEach(box => box.remove());

        console.log('📦 Creating new diff box...');
        const diffBox = document.createElement('div');
        diffBox.className = 'file-diff-box';
        
        const badge = isNewFile ? '<span style="color: #00ff00;">NEW FILE</span>' : '<span style="color: #ffa500;">EDIT</span>';
        
        let diffHtml = '';
        if (isNewFile && preview) {
            diffHtml = \`<div class="diff-content">\${escapeHtml(preview)}</div>\`;
        } else {
            // Format diff with colors
            const diffLines = diff.split('\\n');
            diffHtml = '<div class="diff-content">';
            for (const line of diffLines) {
                if (line.startsWith('+') && !line.startsWith('+++')) {
                    diffHtml += \`<div class="diff-line-add">\${escapeHtml(line)}</div>\`;
                } else if (line.startsWith('-') && !line.startsWith('---')) {
                    diffHtml += \`<div class="diff-line-remove">\${escapeHtml(line)}</div>\`;
                } else if (line.startsWith('@@')) {
                    diffHtml += \`<div style="color: #00bfff;">\${escapeHtml(line)}</div>\`;
                } else {
                    diffHtml += \`<div class="diff-line-context">\${escapeHtml(line)}</div>\`;
                }
            }
            diffHtml += '</div>';
        }
        
        diffBox.innerHTML = \`
            <div class="diff-header">
                <div>
                    <span>📝 File Change Request</span> \${badge}
                </div>
            </div>
            <div class="diff-file-path">\${filePath}</div>
            \${diffHtml}
            <div class="diff-buttons">
                <button class="diff-btn diff-btn-accept" onclick="handleFileDiff('\${changeId}', true)">
                    ✓ Accept Changes
                </button>
                <button class="diff-btn diff-btn-reject" onclick="handleFileDiff('\${changeId}', false)">
                    ✗ Reject Changes
                </button>
            </div>
        \`;
        
        console.log('➕ Appending diff box to terminal container');
        terminalContainer.appendChild(diffBox);
        terminalContainer.scrollTop = terminalContainer.scrollHeight;
        console.log('✅ Diff box added and scrolled into view');
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    window.handleFileDiff = async function(changeId, approved) {
        const diffBox = terminalContainer.querySelector('.file-diff-box');
        if (diffBox) {
            diffBox.remove();
        }

        try {
            const response = await fetch('http://localhost:8000/approve-file-change', {
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

    function addChatMessage(sender, text, isUser = false) {
        const msg = document.createElement('div');
        msg.className = 'chat-message ' + (isUser ? 'user-message' : 'agent-message');
        msg.innerHTML = '<strong>' + sender + ':</strong> ' + text;
        chatContainer.appendChild(msg);
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    async function send() {
        const input = document.getElementById('input');
        const text = input.value.trim();
        
        if (!text) return;

        addChatMessage('You', text, true);
        input.value = '';
        input.disabled = true;

        try {
            addTerminalOutput('⚙️ Agent processing request...', 'warning');
            
            // Include session ID in request to maintain chat history
            const requestBody = { 
                message: text
            };
            
            if (sessionId) {
                requestBody.session_id = sessionId;
            }
            
            const response = await fetch('http://localhost:8000/chat', {
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
            input.disabled = false;
            input.focus();
        }
    }
    
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
            await fetch('http://localhost:8000/clear-history', {
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
            const response = await fetch('http://localhost:8000/sessions');
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