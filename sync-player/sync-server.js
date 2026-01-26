// sync-server.js
import { WebSocketServer } from 'ws';

const PORT = 5001;
const HOST = 'localhost';
const wss = new WebSocketServer({ port: PORT });

// Track all clients and their states
const clients = new Map(); // ws -> {id, ready, mediaReady, currentTime, isProcessing}
let commandCounter = 0;
const recentCommands = new Set(); // Prevent command loops

console.log(`✅ Sync server listening on ws://${HOST}:${PORT}`);

// Generate unique client ID
function generateClientId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// Generate unique command ID to prevent loops
function generateCommandId() {
    return 'cmd_' + Date.now() + '_' + (commandCounter++);
}

wss.on('connection', (ws) => {
    const clientId = generateClientId();
    
    // Initialize client state
    clients.set(ws, {
        id: clientId,
        ready: false,
        mediaReady: false,
        currentTime: 0,
        isProcessing: false,
        lastCommandId: null
    });
    
    console.log(`📡 New client: ${clientId} (Total: ${clients.size})`);
    
    // Send welcome with client ID
    ws.send(JSON.stringify({
        type: 'welcome',
        clientId: clientId,
        serverTime: Date.now()
    }));
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            const clientInfo = clients.get(ws);
            
            // Update client state
            if (data.currentTime !== undefined) {
                clientInfo.currentTime = data.currentTime;
            }
            if (data.mediaReady !== undefined) {
                clientInfo.mediaReady = data.mediaReady;
            }
            
            // Skip if this is a response to a server command (anti-loop)
            if (data.responseTo) {
                console.log(`[${clientId}] Response to command ${data.responseTo}`);
                return;
            }
            
            switch (data.type) {
                case 'sync_request':
                    // Handle time sync request
                    ws.send(JSON.stringify({
                        type: 'sync',
                        serverTime: Date.now(),
                        clientSendTime: data.clientTime,
                        requestId: data.requestId
                    }));
                    break;
                    
                case 'client_ready':
                    // Client reports media is ready
                    clientInfo.ready = true;
                    clientInfo.mediaReady = true;
                    console.log(`✅ ${clientId} ready`);
                    
                    // Send initial sync to position 0 ONLY for new clients
                    if (!clientInfo.isProcessing) {
                        clientInfo.isProcessing = true;
                        setTimeout(() => {
                            const cmdId = generateCommandId();
                            recentCommands.add(cmdId);
                            
                            ws.send(JSON.stringify({
                                type: 'seek',
                                commandId: cmdId,
                                timestamp: Date.now() + 100,
                                position: 0,
                                initiatedBy: 'server',
                                isInitialSync: true
                            }));
                            
                            // Clean up command ID after 5 seconds
                            setTimeout(() => recentCommands.delete(cmdId), 5000);
                        }, 1000); // 1 second delay for new clients
                    }
                    break;
                    
                case 'client_play':
                    // Prevent loop: ignore if this is a response to a recent command
                    if (data.commandId && recentCommands.has(data.commandId)) {
                        console.log(`🔄 ${clientId}: Ignoring loopback command ${data.commandId}`);
                        return;
                    }
                    
                    // Client requests to play
                    const playCmdId = generateCommandId();
                    recentCommands.add(playCmdId);
                    
                    // Use the position from the client, or their current time
                    const position = data.position !== undefined ? data.position : clientInfo.currentTime;
                    
                    console.log(`▶️  ${clientId} playing at ${position.toFixed(2)}s`);
                    
                    // Broadcast play command to ALL clients (including sender)
                    broadcast({
                        type: 'play',
                        commandId: playCmdId,
                        timestamp: Date.now() + 300, // 300ms future for sync
                        position: position,
                        initiatedBy: clientId,
                        serverTime: Date.now()
                    }, ws); // Include sender
                    
                    // Clean up command ID
                    setTimeout(() => recentCommands.delete(playCmdId), 5000);
                    break;
                    
                case 'client_pause':
                    if (data.commandId && recentCommands.has(data.commandId)) {
                        console.log(`🔄 ${clientId}: Ignoring loopback pause command`);
                        return;
                    }
                    
                    const pauseCmdId = generateCommandId();
                    recentCommands.add(pauseCmdId);
                    
                    console.log(`⏸️  ${clientId} pausing`);
                    
                    broadcast({
                        type: 'pause',
                        commandId: pauseCmdId,
                        timestamp: Date.now(),
                        initiatedBy: clientId
                    }, ws);
                    
                    setTimeout(() => recentCommands.delete(pauseCmdId), 5000);
                    break;
                    
                case 'client_seek':
                    // Check if this is a loopback
                    if (data.commandId && recentCommands.has(data.commandId)) {
                        console.log(`🔄 ${clientId}: Ignoring loopback seek command`);
                        return;
                    }
                    
                    // Only broadcast manual seeks (not responses to sync)
                    if (!data.isResponse) {
                        const seekCmdId = generateCommandId();
                        recentCommands.add(seekCmdId);
                        
                        console.log(`🎯 ${clientId} seeking to ${data.position.toFixed(2)}s`);
                        
                        broadcast({
                            type: 'seek',
                            commandId: seekCmdId,
                            timestamp: Date.now() + 100,
                            position: data.position,
                            initiatedBy: clientId
                        }, ws);
                        
                        setTimeout(() => recentCommands.delete(seekCmdId), 5000);
                    }
                    break;
                    
                case 'heartbeat':
                    ws.send(JSON.stringify({
                        type: 'heartbeat_ack',
                        serverTime: Date.now()
                    }));
                    break;
                    
                case 'status_update':
                    // Just update client info, don't broadcast
                    clientInfo.currentTime = data.currentTime || clientInfo.currentTime;
                    clientInfo.mediaReady = data.mediaReady !== undefined ? data.mediaReady : clientInfo.mediaReady;
                    break;
                    
                default:
                    console.log(`[${clientId}] Unknown type: ${data.type}`);
            }
        } catch (error) {
            console.error(`❌ Error from client:`, error);
        }
    });
    
    ws.on('close', () => {
        const clientInfo = clients.get(ws);
        if (clientInfo) {
            console.log(`👋 ${clientInfo.id} disconnected (${clients.size - 1} remain)`);
        }
        clients.delete(ws);
    });
    
    ws.on('error', (error) => {
        console.error(`⚠️  Error:`, error);
        clients.delete(ws);
    });
});

// Broadcast to all clients (optionally excluding sender)
function broadcast(data, sender = null) {
    const message = JSON.stringify(data);
    let count = 0;
    
    clients.forEach((clientInfo, client) => {
        // Skip sender if specified
        if (sender && client === sender) return;
        
        if (client.readyState === client.OPEN) {
            client.send(message);
            count++;
            
            // Mark client as processing this command
            clientInfo.isProcessing = true;
            clientInfo.lastCommandId = data.commandId;
            
            // Reset processing flag after a delay
            setTimeout(() => {
                if (clients.has(client)) {
                    clients.get(client).isProcessing = false;
                }
            }, 1000);
        }
    });
    
    // Also send to sender if it's a play or pause command (so sender syncs too)
    if (sender && sender.readyState === sender.OPEN && (data.type === 'play' || data.type === 'pause')) {
        sender.send(message);
        count++;
    }
    
    console.log(`📢 ${data.type} to ${count} clients (cmd: ${data.commandId})`);
}

// Console control interface
import readline from 'readline';
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

rl.on('line', (input) => {
    const [command, ...args] = input.trim().split(' ');
    
    switch (command) {
        case 'play':
            const playCmdId = generateCommandId();
            recentCommands.add(playCmdId);
            
            broadcast({
                type: 'play',
                commandId: playCmdId,
                timestamp: Date.now() + 300,
                position: parseFloat(args[0]) || 0,
                initiatedBy: 'console'
            });
            
            setTimeout(() => recentCommands.delete(playCmdId), 5000);
            break;
            
        case 'pause':
            const pauseCmdId = generateCommandId();
            recentCommands.add(pauseCmdId);
            
            broadcast({
                type: 'pause',
                commandId: pauseCmdId,
                timestamp: Date.now(),
                initiatedBy: 'console'
            });
            
            setTimeout(() => recentCommands.delete(pauseCmdId), 5000);
            break;
            
        case 'seek':
            const seekCmdId = generateCommandId();
            recentCommands.add(seekCmdId);
            
            broadcast({
                type: 'seek',
                commandId: seekCmdId,
                timestamp: Date.now() + 100,
                position: parseFloat(args[0]) || 0,
                initiatedBy: 'console'
            });
            
            setTimeout(() => recentCommands.delete(seekCmdId), 5000);
            break;
            
        case 'list':
            console.log('\n📋 Connected clients:');
            clients.forEach((client, ws) => {
                console.log(`  ${client.id} - Ready: ${client.ready}, Time: ${client.currentTime.toFixed(2)}s`);
            });
            console.log(`Total: ${clients.size}\n`);
            break;
            
        case 'sync':
            // Force all clients to sync to 0
            clients.forEach((clientInfo, client) => {
                if (client.readyState === client.OPEN) {
                    const cmdId = generateCommandId();
                    recentCommands.add(cmdId);
                    
                    client.send(JSON.stringify({
                        type: 'seek',
                        commandId: cmdId,
                        timestamp: Date.now() + 100,
                        position: 0,
                        initiatedBy: 'server',
                        isInitialSync: true
                    }));
                    
                    setTimeout(() => recentCommands.delete(cmdId), 5000);
                }
            });
            console.log('🔄 Manual sync to 0 sent');
            break;
            
        case 'help':
            console.log(`
🎮 Console Commands:
  play [time]    - Play from time (default: 0)
  pause          - Pause all
  seek <time>    - Seek all to time
  list           - Show connected clients
  sync           - Force sync all to 0
  help           - This help
            `);
            break;
            
        default:
            console.log(`Unknown: "${command}". Type 'help' for commands.`);
    }
});

console.log(`🚀 Server ready on ws://${HOST}:${PORT}`);
console.log('🎮 Type "help" for console commands\n');
