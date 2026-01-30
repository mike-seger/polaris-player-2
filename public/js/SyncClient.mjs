// sync-client.js
import ToggleButton from './ToggleButton.js';

const DEFAULT_SERVER = 'localhost:5001';

// Enhanced sync client with proper media synchronization
class VideoSyncClient {
    constructor(mediaElement, statusUpdateHandler = null, serverAddress = null, toggleButtonConfig = null) {
        this.video = mediaElement;
        this.statusUpdateHandler = statusUpdateHandler;
        this.serverAddress = serverAddress || DEFAULT_SERVER;
        this.toggleButton = null;
        this.toggleButtonConfig = toggleButtonConfig;
        this.socket = null;
        this.audioContext = null;
        this.masterTimeOffset = 0;
        this.isSynchronized = false;
        this.mediaReady = false;
        this.scheduledPlayTime = null;
        
        // Loop prevention
        this.lastSeekCommandId = null;
        this.lastPlayCommandId = null;
        this.lastPauseCommandId = null;
        this.lastSyncRequestId = null;
        
        // Pending operations
        this.pendingPlayTimeout = null;
        this.pendingAnimationFrame = null;
        this.isSeeking = false;
        
        // Media ready check
        this.mediaReadyCheckInterval = null;
        this.mediaReadyReported = false;
        
        // Seek tracking
        this.lastSeekTime = 0;
        this.seekThrottleTime = 1000; // Only send seeks every 1 second
        this.ignoreNextSeek = false; // Ignore seeks from server commands
        
        this.init();
    }
    init() {
        console.log('Initializing sync client...');

        // Initialize toggle button if configured
        if (this.toggleButtonConfig) {
            this.initToggleButton();
            this.updateButtonState('disconnected');
        }
        
        // Create Web Audio context for precise timing
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            console.log('Audio context created');
        } catch (error) {
            console.warn('AudioContext creation failed:', error);
            this.audioContext = null;
        }
        
        // Connect audio through Web Audio API
        this.connectWebAudio();
        
        // Start media ready detection immediately
        this.startMediaReadyDetection();
        
        // Connect to sync server
        this.connectWebSocket();
        
        // Setup media event listeners (including seek capture)
        this.setupMediaEvents();
        
        // Setup sync checks
        setInterval(() => this.checkSync(), 500);
        
        // Clean up on page unload
        window.addEventListener('beforeunload', () => {
            this.cleanup();
        });
        
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.cleanupPending();
            }
        });
    }

    initToggleButton() {
        const config = this.toggleButtonConfig;

        // Default colors
        const colorConnected = config?.colorConnected || '#cc0000';
        const colorDisconnected = config?.colorDisconnected || '#ffffff';
        const colorUnavailable = config?.colorUnavailable || '#a8b3c7';

        this.buttonColors = {
            connected: colorConnected,
            disconnected: colorDisconnected,
            unavailable: colorUnavailable
        };

        try {
            this.toggleButton = new ToggleButton({
                size: config?.size || 40,
                svgUrl: config?.svgUrl || './img/link.svg',
                colorOff: colorUnavailable,
                colorOn: colorConnected,
                checked: false,
                onChange: (checked) => {
                    if (checked) {
                        this.reconnect();
                    } else {
                        this.disconnect();
                    }

                    if (typeof config?.onChange === 'function') {
                        config.onChange(checked, this);
                    }
                }
            });

            if (config?.container) {
                this.toggleButton.mount(config.container);
            }
        } catch (error) {
            console.warn('Failed to initialize toggle button:', error);
        }
    }

    updateButtonState(state) {
        if (!this.toggleButton || !this.buttonColors) return;

        switch(state) {
            case 'connected':
                this.toggleButton.colorOff = this.buttonColors.connected;
                this.toggleButton.colorOn = this.buttonColors.connected;
                this.toggleButton.setChecked(true);
                break;
            case 'disconnected':
                this.toggleButton.colorOff = this.buttonColors.disconnected;
                this.toggleButton.colorOn = this.buttonColors.connected;
                this.toggleButton.setChecked(false);
                break;
            case 'unavailable':
                this.toggleButton.colorOff = this.buttonColors.unavailable;
                this.toggleButton.colorOn = this.buttonColors.unavailable;
                this.toggleButton.setChecked(false);
                break;
        }

        this.toggleButton.updateColor();
    }
    
    connectWebAudio() {
        if (!this.audioContext) return;
        
        try {
            // Create Web Audio source from video element
            this.mediaSource = this.audioContext.createMediaElementSource(this.video);
            this.gainNode = this.audioContext.createGain();
            
            // Connect: video → gain → speakers
            this.mediaSource.connect(this.gainNode);
            this.gainNode.connect(this.audioContext.destination);
            
            console.log('Web Audio connected for precise timing');
        } catch (error) {
            console.warn('Web Audio connection failed, using fallback:', error);
        }
    }
    
    startMediaReadyDetection() {
        console.log('Starting media ready detection...');
        
        // Pause immediately to prevent autoplay from interfering with sync
        if (!this.video.paused) {
            console.log('Pausing video to wait for sync');
            this.video.pause();
            this.video.currentTime = 0;
        }
        
        // Method 1: Event listeners
        const markReady = () => {
            if (!this.mediaReady) {
                console.log('Media marked as ready via event');
                this.mediaReady = true;
                this.reportReady();
            }
        };
        
        this.video.addEventListener('loadeddata', markReady);
        this.video.addEventListener('canplay', markReady);
        this.video.addEventListener('canplaythrough', markReady);
        
        // Method 2: Check video state periodically
        this.mediaReadyCheckInterval = setInterval(() => {
            // Check if video has metadata and can play
            if (this.video.readyState >= 2 && !this.mediaReady) { // HAVE_CURRENT_DATA or better
                console.log(`Video readyState: ${this.video.readyState}, duration: ${this.video.duration}`);
                this.mediaReady = true;
                this.reportReady();
                clearInterval(this.mediaReadyCheckInterval);
            }
        }, 500);
        
        // Method 3: If video already has data when we check
        setTimeout(() => {
            if (this.video.readyState > 0 && !this.mediaReady) {
                console.log('Initial check: Video has data, marking ready');
                this.mediaReady = true;
                this.reportReady();
            }
        }, 100);
    }
    
    setupMediaEvents() {
        console.log('Setting up media event listeners...');
        
        // Capture manual seeks from user interaction
        this.video.addEventListener('seeking', () => {
            this.isSeeking = true;
            const now = Date.now();
            
            // Throttle seek broadcasts to avoid spamming
            if (now - this.lastSeekTime > this.seekThrottleTime && !this.ignoreNextSeek) {
                this.lastSeekTime = now;
                
                // Small delay to capture the final seek position
                setTimeout(() => {
                    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.isSynchronized) {
                        const commandId = 'seek_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                        console.log(`Broadcasting manual seek to ${this.video.currentTime.toFixed(2)}s`);
                        
                        this.socket.send(JSON.stringify({
                            type: 'client_seek',
                            commandId: commandId,
                            position: this.video.currentTime,
                            clientTime: performance.now(),
                            isResponse: false // This is a manual seek, not a response
                        }));
                    }
                }, 100);
            }
            
            // Reset ignore flag after a short delay
            if (this.ignoreNextSeek) {
                setTimeout(() => {
                    this.ignoreNextSeek = false;
                }, 500);
            }
        });
        
        this.video.addEventListener('seeked', () => {
            this.isSeeking = false;
            
            // Report new position after seek completes
            setTimeout(() => {
                if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                    this.socket.send(JSON.stringify({
                        type: 'status_update',
                        currentTime: this.video.currentTime,
                        clientTime: performance.now()
                    }));
                }
            }, 50);
        });
        
        // Capture play/pause from user interaction
        this.video.addEventListener('play', () => {
            if (this.socket && this.socket.readyState === WebSocket.OPEN && this.isSynchronized) {
                // Check if this was triggered by our own sync, not user
                if (!this.ignoreNextPlayPause) {
                    const commandId = 'play_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                    console.log('Broadcasting manual play');
                    
                    this.socket.send(JSON.stringify({
                        type: 'client_play',
                        commandId: commandId,
                        position: this.video.currentTime,
                        clientTime: performance.now()
                    }));
                } else {
                    this.ignoreNextPlayPause = false;
                }
            }
        });
        
        this.video.addEventListener('pause', () => {
            console.log(`[PAUSE EVENT] paused=${this.video.paused}, ignoreFlag=${this.ignoreNextPlayPause}, synced=${this.isSynchronized}`);
            if (this.socket && this.socket.readyState === WebSocket.OPEN && this.isSynchronized) {
                if (!this.ignoreNextPlayPause) {
                    const commandId = 'pause_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                    console.log('📤 Broadcasting manual pause to server');
                    
                    this.socket.send(JSON.stringify({
                        type: 'client_pause',
                        commandId: commandId,
                        currentTime: this.video.currentTime,
                        clientTime: performance.now()
                    }));
                } else {
                    console.log('⏭️  Ignoring pause event (triggered by server command)');
                    this.ignoreNextPlayPause = false;
                }
            } else {
                console.log(`⚠️  Pause not broadcast: socket=${!!this.socket}, open=${this.socket?.readyState === WebSocket.OPEN}, synced=${this.isSynchronized}`);
            }
        });
        
        // Time update - but throttle it to avoid spamming
        let lastTimeUpdate = 0;
        this.video.addEventListener('timeupdate', () => {
            const now = Date.now();
            if (now - lastTimeUpdate > 1000) { // Only send every second
                lastTimeUpdate = now;
                
                if (this.socket && this.socket.readyState === WebSocket.OPEN && !this.isSeeking) {
                    this.socket.send(JSON.stringify({
                        type: 'status_update',
                        currentTime: this.video.currentTime,
                        isPlaying: !this.video.paused,
                        clientTime: performance.now()
                    }));
                }
            }
            
            // Drift checking
            if (this.scheduledPlayTime && this.audioContext) {
                const currentAudioTime = this.audioContext.currentTime;
                const expectedTime = this.scheduledPlayTime + (this.video.currentTime - (this.video.startTime || 0));
                const drift = currentAudioTime - expectedTime;
                
                // Small correction if drifting
                if (Math.abs(drift) > 0.05) { // 50ms drift
                    this.applyDriftCorrection(drift);
                }
            }
        });
        
        // Also capture input events on the video controls
        this.video.addEventListener('click', (e) => {
            // This helps capture clicks on the native control bar
            console.log('Video clicked, current time:', this.video.currentTime);
        });
        
        // Add keyboard shortcuts for testing
        document.addEventListener('keydown', (e) => {
            if (e.target === this.video || document.activeElement === this.video) {
                switch(e.key) {
                    case ' ':
                        // Space bar - play/pause
                        e.preventDefault();
                        break;
                    case 'ArrowLeft':
                        // Left arrow - seek back 5 seconds
                        e.preventDefault();
                        this.broadcastSeek(this.video.currentTime - 5);
                        break;
                    case 'ArrowRight':
                        // Right arrow - seek forward 5 seconds
                        e.preventDefault();
                        this.broadcastSeek(this.video.currentTime + 5);
                        break;
                }
            }
        });
    }
    
    broadcastSeek(position) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN && this.isSynchronized) {
            const commandId = 'keyseek_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            console.log(`Broadcasting keyboard seek to ${position.toFixed(2)}s`);
            
            this.socket.send(JSON.stringify({
                type: 'client_seek',
                commandId: commandId,
                position: Math.max(0, position),
                clientTime: performance.now(),
                isResponse: false
            }));
        }
    }
    
    connectWebSocket() {
        // Parse server address
        const [host, port] = this.serverAddress.split(':');
        const wsHost = host || 'localhost';
        const wsPort = port || '5001';
        
        // Connect to sync server
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${wsHost}:${wsPort}`;
        
        console.log(`Connecting to WebSocket: ${wsUrl}`);
        this.socket = new WebSocket(wsUrl);
        
        this.socket.onopen = () => {
            console.log('Connected to sync server');
            this.updateStatus('Connected - Waiting for media...');
            this.updateButtonState('disconnected');
            this.requestSync();
            
            // Start heartbeat
            setInterval(() => {
                if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                    this.socket.send(JSON.stringify({
                        type: 'heartbeat',
                        clientTime: performance.now()
                    }));
                }
            }, 5000);
        };
        
        this.socket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleMessage(data);
            } catch (error) {
                console.error('Error parsing WebSocket message:', error);
            }
        };
        
        this.socket.onerror = (error) => {
            console.error('WebSocket error:', error);
            this.updateStatus('Connection error');
            this.updateButtonState('disconnected');
        };
        
        this.socket.onclose = () => {
            console.log('WebSocket connection closed');
            this.updateStatus('Disconnected');
            this.updateButtonState('disconnected');
        };
    }
    
    handleMessage(data) {
        // Skip logging for heartbeat_ack to reduce noise
        if (data.type !== 'heartbeat_ack') {
            console.log(`Received message type: ${data.type}`);
        }
        
        switch (data.type) {
            case 'welcome':
                console.log('Server welcome. Client ID:', data.clientId);
                this.updateStatus(`Connected as ${data.clientId.substring(0, 8)}...`);
                break;
                
            case 'sync':
                this.handleSync(data);
                break;
                
            case 'play':
                this.handlePlay(data);
                break;
                
            case 'pause':
                this.handlePause(data);
                break;
                
            case 'seek':
                this.handleSeek(data);
                break;
                
            case 'heartbeat_ack':
                // Heartbeat acknowledgment - no action needed
                break;
                
            case 'all_clients_ready':
                console.log(`All ${data.clientCount} clients are ready`);
                this.updateStatus(`All ${data.clientCount} clients ready`);
                break;
                
            default:
                console.log('Unknown message type:', data.type);
        }
    }
    
    handleSync(syncData) {
        // Calculate network latency and time offset
        const now = performance.now();
        const roundTrip = now - syncData.clientSendTime;
        const latency = roundTrip / 2;
        const serverTime = syncData.serverTime + latency;
        const clientTime = now;
        
        // Store offset between server and client
        this.masterTimeOffset = serverTime - clientTime;
        this.updateButtonState('connected');
        
        console.log(`Time synced! Offset: ${this.masterTimeOffset.toFixed(2)}ms, Latency: ${latency.toFixed(2)}ms`);
        this.updateStatus(`Synced ±${latency.toFixed(0)}ms | Ready: ${this.mediaReady}`);
        
        this.isSynchronized = true;
        
        // Report ready if media is loaded
        if (this.mediaReady && !this.mediaReadyReported) {
            this.reportReady();
        }
    }
    
    handlePlay(playData) {
        // Skip if we already processed this command (loop prevention)
        if (playData.commandId && playData.commandId === this.lastPlayCommandId) {
            console.log(`Skipping duplicate play command: ${playData.commandId}`);
            return;
        }
        
        if (!this.isSynchronized) {
            console.log('Not synced yet, skipping play');
            return;
        }
        
        if (!this.mediaReady) {
            console.log('Media not ready yet, marking ready and playing');
            this.mediaReady = true;
            this.reportReady();
        }
        
        // Store this command ID to prevent processing it again
        if (playData.commandId) {
            this.lastPlayCommandId = playData.commandId;
            
            // Clear after 5 seconds to prevent blocking legitimate plays
            setTimeout(() => {
                if (this.lastPlayCommandId === playData.commandId) {
                    this.lastPlayCommandId = null;
                }
            }, 5000);
        }
        
        // Set flag to ignore the next play event we generate
        this.ignoreNextPlayPause = true;
        
        const serverPlayTime = playData.timestamp;
        const targetPosition = playData.position || 0;
        
        // Calculate when to play in local time
        const localPlayTime = serverPlayTime - this.masterTimeOffset;
        const delay = localPlayTime - performance.now();
        
        console.log(`Scheduled play in ${delay > 0 ? delay.toFixed(0) + 'ms' : 'NOW'} at position ${targetPosition.toFixed(2)}s`);
        
        // If we're already playing and close to target position, skip seek
        const shouldSeek = !this.video.paused || Math.abs(this.video.currentTime - targetPosition) > 0.1;
        
        if (shouldSeek) {
            this.video.currentTime = targetPosition;
        } else {
            console.log(`Already playing at ${this.video.currentTime.toFixed(2)}s (close to target)`);
        }
        
        // Cancel any pending play schedule
        this.cleanupPending();
        
        // Schedule playback
        if (delay > 100) {
            // If far in future, use setTimeout for coarse scheduling
            console.log(`Using setTimeout for play in ${delay.toFixed(0)}ms`);
            this.pendingPlayTimeout = setTimeout(() => {
                this.pendingPlayTimeout = null;
                this.executePrecisePlay(localPlayTime, targetPosition, playData.commandId);
            }, Math.max(0, delay - 20));
        } else if (delay > 0) {
            // Near future, use requestAnimationFrame for better precision
            console.log(`Using requestAnimationFrame for precise play`);
            this.executePrecisePlay(localPlayTime, targetPosition, playData.commandId);
        } else {
            // Past time, play immediately with compensation
            const lateBy = -delay;
            console.log(`Playing late by ${lateBy.toFixed(0)}ms`);
            
            // If we're already playing, don't restart
            if (!this.video.paused) {
                console.log(`Already playing, adjusting schedule time only`);
                if (this.audioContext) {
                    this.scheduledPlayTime = this.audioContext.currentTime - (lateBy / 1000);
                }
                this.video.startTime = targetPosition;
            } else {
                this.video.play().then(() => {
                    if (this.audioContext) {
                        this.scheduledPlayTime = this.audioContext.currentTime - (lateBy / 1000);
                    }
                    this.video.startTime = targetPosition;
                    console.log(`Started playback`);
                    
                    // Reset ignore flag after event fires
                    setTimeout(() => {
                        this.ignoreNextPlayPause = false;
                    }, 100);
                    
                    // Send status update (but not for initial sync)
                    if (playData.commandId && !playData.isInitialSync) {
                        this.sendStatusUpdate(playData.commandId);
                    }
                }).catch(error => {
                    console.error('Play failed:', error);
                    this.ignoreNextPlayPause = false;
                });
            }
        }
    }
    
    executePrecisePlay(targetPerformanceTime, startPosition, commandId) {
        // Cancel any pending animation frame
        if (this.pendingAnimationFrame) {
            cancelAnimationFrame(this.pendingAnimationFrame);
        }
        
        // Convert performance time to audio context time
        const audioTime = this.audioContext ? this.audioContext.currentTime : performance.now() / 1000;
        const performanceNow = performance.now();
        const targetAudioTime = audioTime + ((targetPerformanceTime - performanceNow) / 1000);
        
        // Ensure we're at the right position (within tolerance)
        if (Math.abs(this.video.currentTime - startPosition) > 0.1) {
            this.video.currentTime = startPosition;
        }
        
        // Store when we scheduled playback
        this.video.startTime = startPosition;
        this.scheduledPlayTime = targetAudioTime;
        
        console.log(`Precise play scheduled: audio time ${targetAudioTime.toFixed(3)} (${((targetAudioTime - audioTime) * 1000).toFixed(0)}ms from now)`);
        
        // Small pre-buffer for accuracy
        const preBuffer = 0.03; // 30ms
        
        if (targetAudioTime - audioTime > preBuffer) {
            // Schedule with requestAnimationFrame for last-millisecond accuracy
            const scheduleFrame = () => {
                const now = this.audioContext ? this.audioContext.currentTime : performance.now() / 1000;
                if (now >= targetAudioTime - preBuffer) {
                    // Time to play!
                    this.video.play().then(() => {
                        console.log(`Play started`);
                        
                        // Reset ignore flag
                        setTimeout(() => {
                            this.ignoreNextPlayPause = false;
                        }, 100);
                        
                        // Send status update (but not for initial sync)
                        if (commandId) {
                            this.sendStatusUpdate(commandId);
                        }
                    }).catch(error => {
                        console.error('Precise play failed:', error);
                        this.ignoreNextPlayPause = false;
                        // Fallback to immediate play
                        this.video.play();
                    });
                    
                    this.pendingAnimationFrame = null;
                } else {
                    // Keep waiting
                    this.pendingAnimationFrame = requestAnimationFrame(scheduleFrame);
                }
            };
            
            this.pendingAnimationFrame = requestAnimationFrame(scheduleFrame);
        } else {
            // Play immediately if we're within the buffer window
            console.log(`Within buffer window, playing immediately`);
            this.video.play().then(() => {
                console.log(`Immediate play started`);
                
                // Reset ignore flag
                setTimeout(() => {
                    this.ignoreNextPlayPause = false;
                }, 100);
                
                if (commandId) {
                    this.sendStatusUpdate(commandId);
                }
            }).catch(error => {
                console.error('Immediate play failed:', error);
                this.ignoreNextPlayPause = false;
            });
        }
    }
    
    handlePause(pauseData) {
        console.log(`📥 Received PAUSE command from ${pauseData.initiatedBy}, cmdId=${pauseData.commandId}`);
        
        // Skip if duplicate
        if (pauseData.commandId && pauseData.commandId === this.lastPauseCommandId) {
            console.log(`⏭️  Skipping duplicate pause command: ${pauseData.commandId}`);
            return;
        }
        
        if (pauseData.commandId) {
            this.lastPauseCommandId = pauseData.commandId;
            setTimeout(() => {
                if (this.lastPauseCommandId === pauseData.commandId) {
                    this.lastPauseCommandId = null;
                }
            }, 5000);
        }
        
        // Set flag to ignore the next pause event we generate
        this.ignoreNextPlayPause = true;
        console.log(`🚫 Set ignoreNextPlayPause=true before pausing`);
        
        const serverPauseTime = pauseData.timestamp;
        const localPauseTime = serverPauseTime - this.masterTimeOffset;
        const delay = localPauseTime - performance.now();
        
        const pauseAt = () => {
            console.log(`⏸️  Executing pause (was paused: ${this.video.paused})`);
            
            // Only pause if not already paused
            if (!this.video.paused) {
                this.video.pause();
            }
            
            // Clear scheduled play time
            this.scheduledPlayTime = null;
            
            // Reset the ignore flag after a short delay to allow the event to fire
            setTimeout(() => {
                this.ignoreNextPlayPause = false;
            }, 100);
            
            // Send status update
            if (pauseData.commandId && !pauseData.isInitialSync) {
                this.sendStatusUpdate(pauseData.commandId);
            }
        };
        
        if (delay > 0) {
            console.log(`⏱️  Scheduling pause in ${delay.toFixed(0)}ms`);
            setTimeout(pauseAt, delay);
        } else {
            pauseAt();
        }
    }
    
    handleSeek(seekData) {
        // Skip if we already processed this command (loop prevention)
        if (seekData.commandId && seekData.commandId === this.lastSeekCommandId) {
            console.log(`Skipping duplicate seek command: ${seekData.commandId}`);
            return;
        }
        
        // Store this command ID to prevent processing it again
        if (seekData.commandId) {
            this.lastSeekCommandId = seekData.commandId;
            
            // Clear after 5 seconds to prevent blocking legitimate seeks
            setTimeout(() => {
                if (this.lastSeekCommandId === seekData.commandId) {
                    this.lastSeekCommandId = null;
                }
            }, 5000);
        }
        
        const serverSeekTime = seekData.timestamp;
        const localSeekTime = serverSeekTime - this.masterTimeOffset;
        const delay = localSeekTime - performance.now();
        const targetPosition = seekData.position;
        
        console.log(`Scheduled seek to ${targetPosition.toFixed(2)}s in ${delay > 0 ? delay.toFixed(0) + 'ms' : 'now'}`);
        
        // Set flag to ignore the next seek event we generate
        this.ignoreNextSeek = true;
        
        const seekAt = () => {
            // Only seek if we're not already at that position (within a small tolerance)
            const currentPos = this.video.currentTime;
            const diff = Math.abs(currentPos - targetPosition);
            
            if (diff > 0.1) { // Only seek if >100ms difference
                console.log(`Seeking from ${currentPos.toFixed(2)}s to ${targetPosition.toFixed(2)}s`);
                this.video.currentTime = targetPosition;
            } else {
                console.log(`Already at position ${currentPos.toFixed(2)}s (close to target ${targetPosition.toFixed(2)}s)`);
            }
            
            // Update scheduled play time if we're playing
            if (this.scheduledPlayTime) {
                if (this.audioContext) {
                    this.scheduledPlayTime = this.audioContext.currentTime;
                }
                this.video.startTime = targetPosition;
            }
            
            // If this is NOT an initial sync from server, acknowledge to server
            if (this.socket && this.socket.readyState === WebSocket.OPEN && !seekData.isInitialSync) {
                // Small delay to ensure seek completed
                setTimeout(() => {
                    this.socket.send(JSON.stringify({
                        type: 'status_update',
                        currentTime: this.video.currentTime,
                        clientTime: performance.now(),
                        responseTo: seekData.commandId || null
                    }));
                }, 100);
            }
        };
        
        if (delay > 0) {
            setTimeout(seekAt, delay);
        } else {
            // If command is late, execute immediately
            seekAt();
        }
    }
    
    applyDriftCorrection(driftSeconds) {
        // Apply tiny playback rate adjustment
        const correction = 1 + (driftSeconds * 0.1); // Gentle correction
        this.video.playbackRate = Math.max(0.9, Math.min(1.1, correction));
        
        // Throttle logging to once per second
        const now = Date.now();
        if (!this.lastDriftLogTime || now - this.lastDriftLogTime > 1000) {
            this.lastDriftLogTime = now;
            console.log(`Applying drift correction: ${(driftSeconds * 1000).toFixed(1)}ms, rate: ${this.video.playbackRate.toFixed(4)}`);
        }
        
        // Reset after 2 seconds
        if (this.resetPlaybackRateTimeout) {
            clearTimeout(this.resetPlaybackRateTimeout);
        }
        
        this.resetPlaybackRateTimeout = setTimeout(() => {
            if (this.video.playbackRate !== 1.0) {
                this.video.playbackRate = 1.0;
                // Also throttle reset logging
                const resetNow = Date.now();
                if (!this.lastResetLogTime || resetNow - this.lastResetLogTime > 1000) {
                    this.lastResetLogTime = resetNow;
                    console.log('Reset playback rate to 1.0');
                }
            }
            this.resetPlaybackRateTimeout = null;
        }, 2000);
    }
    
    checkSync() {
        if (!this.isSynchronized || !this.scheduledPlayTime || !this.audioContext) return;
        
        const currentAudioTime = this.audioContext.currentTime;
        const expectedTime = this.scheduledPlayTime + (this.video.currentTime - (this.video.startTime || 0));
        const drift = currentAudioTime - expectedTime;
        
        if (Math.abs(drift) > 0.1) { // 100ms drift
            console.log(`Significant drift detected: ${(drift * 1000).toFixed(1)}ms`);
            this.updateStatus(`Drift: ${(drift * 1000).toFixed(0)}ms`);
            this.requestSync();
        }
    }
    
    reportReady() {
        if (this.mediaReadyReported) return;
        
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            console.log('Reporting client ready to server');
            this.socket.send(JSON.stringify({
                type: 'client_ready',
                clientTime: performance.now(),
                duration: this.video.duration || 0,
                currentTime: this.video.currentTime || 0
            }));
            this.mediaReadyReported = true;
            this.updateStatus(`Synced ±0ms | Ready: true`);
        }
    }
    
    requestSync() {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
        
        const requestId = Date.now();
        this.lastSyncRequestId = requestId;
        
        this.socket.send(JSON.stringify({
            type: 'sync_request',
            clientTime: performance.now(),
            requestId: requestId
        }));
    }
    
    sendStatusUpdate(commandId = null) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
        
        // Small delay to ensure playback has actually started
        setTimeout(() => {
            this.socket.send(JSON.stringify({
                type: 'status_update',
                currentTime: this.video.currentTime,
                isPlaying: !this.video.paused,
                mediaReady: this.mediaReady,
                clientTime: performance.now(),
                responseTo: commandId,
                audioTime: this.audioContext ? this.audioContext.currentTime : 0
            }));
        }, 100);
    }
    
    updateStatus(text) {
        console.log(`[Status] ${text}`);
        if (this.statusUpdateHandler) {
            this.statusUpdateHandler(text);
        }
    }
    
    cleanup() {
        if (this.pendingPlayTimeout) {
            clearTimeout(this.pendingPlayTimeout);
        }
        if (this.pendingAnimationFrame) {
            cancelAnimationFrame(this.pendingAnimationFrame);
        }
        if (this.mediaReadyCheckInterval) {
            clearInterval(this.mediaReadyCheckInterval);
        }
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.close();
        }
    }
    
    disconnect() {
        console.log('Disconnecting sync client...');
        this.updateButtonState('disconnected');
        this.cleanup();
        this.isSynchronized = false;
        this.updateStatus('Disconnected');
    }
    
    reconnect(newServerAddress = null) {
        console.log('Reconnecting sync client...');
        if (newServerAddress) {
            this.serverAddress = newServerAddress;
        }
        this.disconnect();
        
        // Small delay before reconnecting
        setTimeout(() => {
            this.connectWebSocket();
            this.requestSync();
        }, 500);
    }
    
    cleanupPending() {
        if (this.pendingPlayTimeout) {
            clearTimeout(this.pendingPlayTimeout);
            this.pendingPlayTimeout = null;
        }
        if (this.pendingAnimationFrame) {
            cancelAnimationFrame(this.pendingAnimationFrame);
            this.pendingAnimationFrame = null;
        }
    }
    
    // Public method to trigger play from UI
    playMedia() {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            const commandId = 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            this.socket.send(JSON.stringify({
                type: 'client_play',
                commandId: commandId,
                clientTime: performance.now(),
                position: this.video.currentTime
            }));
        }
    }
    
    // Public method to trigger pause from UI
    pauseMedia() {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            const commandId = 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            this.socket.send(JSON.stringify({
                type: 'client_pause',
                commandId: commandId,
                clientTime: performance.now()
            }));
        }
    }
}

// Helper function to create a text content updater
function textContentHandler(elementId) {
    return (text) => {
        const el = document.getElementById(elementId);
        if (el) el.textContent = text;
    };
}

// Helper function to create a simple connected/disconnected status handler
function connectionStatusHandler(elementId) {
    return (text) => {
        const el = document.getElementById(elementId);
        if (!el) return;
        
        // Map various status messages to simple connected/disconnected
        if (text.includes('Disconnected') || text.includes('Connection error')) {
            el.textContent = 'Disconnected';
        } else if (text.includes('Connecting')) {
            el.textContent = 'Connecting...';
        } else {
            el.textContent = 'Connected';
        }
    };
}

// Simple initialization function that handles DOMContentLoaded automatically
function createSyncClient(mediaElementId, statusElementIdOrHandler = null) {
    addEventListener('DOMContentLoaded', () => {
        window.syncClient = initSyncClient(mediaElementId, statusElementIdOrHandler);
    });
}

// Helper function to initialize sync client
// Parameters:
//   - mediaElementId: ID of the <video> or <audio> element
//   - statusElementIdOrHandler: (optional) Element ID for status text or a handler function
//   - serverAddress: (optional) Server address (default: 'localhost:5001')
//   - toggleButtonConfig: (optional) Configuration object for ToggleButton:
//       {
//         container: '#element-id' or DOMElement,
//         svgUrl: './img/icon.svg',
//         size: 40,
//         colorConnected: '#cc0000',
//         colorDisconnected: '#ffffff',
//         colorUnavailable: '#a8b3c7',
//         onChange: (checked, syncClient) => { /* custom handler */ }
//       }
function initSyncClient(mediaElementId, statusElementIdOrHandler = null, serverAddress = null, toggleButtonConfig = null) {
    const mediaElement = document.getElementById(mediaElementId);
    
    if (!mediaElement) {
        console.error(`No media element with id "${mediaElementId}" found!`);
        return null;
    }
    
    if (mediaElement.tagName !== 'VIDEO' && mediaElement.tagName !== 'AUDIO') {
        console.error(`Element "${mediaElementId}" is not a video or audio element!`);
        return null;
    }
    
    // Handle status updates - accept either a function or an element ID
    let statusHandler = null;
    if (typeof statusElementIdOrHandler === 'string') {
        const statusEl = document.getElementById(statusElementIdOrHandler);
        if (statusEl) {
            statusHandler = (text) => { statusEl.textContent = text; };
            // Add click handler for manual sync
            statusEl.style.cursor = 'pointer';
            statusEl.title = 'Click to manually sync';
        }
    } else if (typeof statusElementIdOrHandler === 'function') {
        statusHandler = statusElementIdOrHandler;
    }
    
    console.log(`${mediaElement.tagName} element found, initializing sync client...`);
    const syncClient = new VideoSyncClient(mediaElement, statusHandler, serverAddress, toggleButtonConfig);
    
    // Add click handler for manual sync on status element
    if (typeof statusElementIdOrHandler === 'string') {
        const statusEl = document.getElementById(statusElementIdOrHandler);
        if (statusEl) {
            statusEl.addEventListener('click', () => syncClient.requestSync());
        }
    }
    
    console.log('Sync client initialized.');
    
    return syncClient;
}

// Export public API
export { VideoSyncClient, createSyncClient, initSyncClient, textContentHandler, connectionStatusHandler };

// Auto-initialize on page load if data-sync-media attribute is present
// (Disabled when imported as module - use manual initialization instead)
/*
document.addEventListener('DOMContentLoaded', () => {
    // Look for elements with data-sync-media attribute
    const mediaElements = document.querySelectorAll('[data-sync-media]');
    
    if (mediaElements.length === 0) {
        // Fallback: try common IDs
        const commonIds = ['player', 'video', 'audio', 'media'];
        const commonStatusIds = ['syncStatus', 'status', 'sync-status'];
        
        for (const id of commonIds) {
            const el = document.getElementById(id);
            if (el && (el.tagName === 'VIDEO' || el.tagName === 'AUDIO')) {
                // Find status element
                const statusId = commonStatusIds.find(sid => document.getElementById(sid));
                window.syncClient = initSyncClient(id, statusId || null);
                if (window.syncClient) {
                    console.log('Auto-initialized sync client');
                }
                return;
            }
        }
    } else {
        // Initialize each media element with data-sync-media
        mediaElements.forEach(el => {
            const statusId = el.getAttribute('data-sync-status');
            const clientId = el.id || 'syncClient';
            window[clientId] = initSyncClient(el.id, statusId || null);
        });
    }
});
*/
