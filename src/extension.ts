import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    const provider = new AntigravityViewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('antigravity.chatView', provider)
    );
}

class AntigravityViewProvider implements vscode.WebviewViewProvider {
    constructor(private readonly _extensionUri: vscode.Uri) { }

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        webviewView.webview.options = { enableScripts: true };

        // The HTML for your sidebar chat
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
            </head>
            <body>
                <h3>MyAntigravity Agent</h3>
                <div id="chat" style="height: 300px; overflow-y: auto; border: 1px solid #ccc; margin-bottom: 10px;"></div>
                <input id="input" type="text" style="width: 80%;" placeholder="Ask agent to build...">
                <button onclick="send()">Send3</button>



                <script>
    const vscode = acquireVsCodeApi();
    const logContainer = document.getElementById('chat');

    const socket = new WebSocket('ws://localhost:8000/ws/logs');

    socket.onopen = () => {
        console.log('✅ WebSocket connected');
        const div = document.createElement('div');
        div.style.color = 'lime';
        div.textContent = 'WebSocket connected';
        logContainer.appendChild(div);
    };

    socket.onerror = (e) => {
        console.error('❌ WebSocket error', e);
        const div = document.createElement('div');
        div.style.color = 'red';
        div.textContent = 'WebSocket error – check DevTools';
        logContainer.appendChild(div);
    };

    socket.onclose = () => {
        console.log('❌ WebSocket closed');
    };

    socket.onmessage = (event) => {
        console.log('📨 message:', event.data);
        const data = JSON.parse(event.data);

        if (data.type === 'log') {
            const logEntry = document.createElement('div');
            logEntry.style.color = '#79c0ff';
            logEntry.textContent = '> ' + data.content;
            logContainer.appendChild(logEntry);
            logContainer.scrollTop = logContainer.scrollHeight;
        }
    };

    async function send() {
        const input = document.getElementById('input');
        const chat = document.getElementById('chat');
        const text = input.value;
        
        chat.innerHTML += '<p><b>You:</b> ' + text + '</p>';

        input.value = '';

        const response = await fetch('http://localhost:8000/chat', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ message: text })
        });
        
        const data = await response.json();
        chat.innerHTML += '<p><b>Agent:</b> ' + data.response + '</p>';
    }
</script>
            </body>
            </html>
        `;
    }
}