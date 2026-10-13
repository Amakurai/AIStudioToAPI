/**
 * Compose request and response modules onto the shared RequestHandler class.
 * All methods run on the same instance, preserving shared state, helper calls,
 * and the existing require("./RequestHandler") API.
 */

const RequestHandler = require("./CommonHandler");
const ConnectionHandler = require("./ConnectionHandler");
const RetryHandler = require("./RetryHandler");
const GeminiHandler = require("./GeminiHandler");
const EmbeddingsHandler = require("./EmbeddingsHandler");
const UploadHandler = require("./UploadHandler");
const ChatCompletionsHandler = require("./ChatCompletionsHandler");
const ResponsesHandler = require("./ResponsesHandler");
const ClaudeHandler = require("./ClaudeHandler");
const ErrorHandler = require("./ErrorHandler");
const TransportHandler = require("./TransportHandler");

for (const Handler of [
    ConnectionHandler,
    RetryHandler,
    GeminiHandler,
    EmbeddingsHandler,
    UploadHandler,
    ChatCompletionsHandler,
    ResponsesHandler,
    ClaudeHandler,
    ErrorHandler,
    TransportHandler,
]) {
    const methods = Object.getOwnPropertyDescriptors(Handler.prototype);
    delete methods.constructor;
    Object.defineProperties(RequestHandler.prototype, methods);
}

module.exports = RequestHandler;
