import { browserAPI } from '../browserAPI';

// Enum for connection states (matching background.ts)
enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    PermanentlyDisconnected
}

// Function to update the status display
function updateStatus(state: ConnectionState) {
    const statusElement = document.getElementById('status') as HTMLDivElement;
    if (!statusElement) return;

    statusElement.classList.remove('connected', 'disconnected');

    switch (state) {
        case ConnectionState.Connected:
            statusElement.classList.add('connected');
            statusElement.textContent = 'Connected to Vigil';
            break;
        case ConnectionState.Connecting:
            statusElement.classList.add('disconnected');
            statusElement.textContent = 'Connecting to Vigil...';
            break;
        case ConnectionState.PermanentlyDisconnected:
            statusElement.classList.add('disconnected');
            statusElement.textContent = 'Connection denied';
            break;
        case ConnectionState.Disconnected:
        default:
            statusElement.classList.add('disconnected');
            statusElement.textContent = 'Disconnected from Vigil';
            break;
    }
}

// Request initial connection state immediately
console.log('Requesting initial state');
browserAPI.runtime.sendMessage({ type: 'GET_CONNECTION_STATE' })
    .then((state: ConnectionState) => {
        console.log('Received state:', state);
        updateStatus(state);
    })
    .catch((error) => {
        console.error('Error getting state:', error);
        updateStatus(ConnectionState.Disconnected);
    });

// Listen for connection state changes
browserAPI.runtime.onMessage.addListener((message: any) => {
    if (message.type === 'CONNECTION_STATE_CHANGED') {
        console.log('State changed:', message.state);
        updateStatus(message.state);
    }
    return true;
});