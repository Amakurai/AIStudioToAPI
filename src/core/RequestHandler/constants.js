const WS_RECONNECT_WAIT_MS = 130000;
const WS_CONNECTION_READY_TIMEOUT_MS = 10000;

// Default timeout constants (in milliseconds)
const DEFAULT_TIMEOUTS = {
    FAKE_STREAM: 300000, // 300 seconds (5 minutes) - timeout for fake streaming (buffered response)
    STREAM_CHUNK: 60000, // 60 seconds - timeout between stream chunks
};

module.exports = { DEFAULT_TIMEOUTS, WS_CONNECTION_READY_TIMEOUT_MS, WS_RECONNECT_WAIT_MS };
