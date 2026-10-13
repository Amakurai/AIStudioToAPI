/**
 * Compose the API-specific methods onto the shared FormatConverter class.
 * All methods run on the same instance, preserving shared logger/server context,
 * helper calls, and the existing require("./FormatConverter") API.
 */

const FormatConverter = require("./CommonConverter");
const ChatCompletionsConverter = require("./ChatCompletionsConverter");
const EmbeddingsConverter = require("./EmbeddingsConverter");
const ClaudeRequestConverter = require("./ClaudeRequestConverter");
const ClaudeResponseConverter = require("./ClaudeResponseConverter");
const ResponsesRequestConverter = require("./ResponsesRequestConverter");
const ResponsesNonStreamResponseConverter = require("./ResponsesNonStreamResponseConverter");
const ResponsesStreamResponseConverter = require("./ResponsesStreamResponseConverter");

for (const Converter of [
    ChatCompletionsConverter,
    EmbeddingsConverter,
    ClaudeRequestConverter,
    ClaudeResponseConverter,
    ResponsesRequestConverter,
    ResponsesNonStreamResponseConverter,
    ResponsesStreamResponseConverter,
]) {
    const methods = Object.getOwnPropertyDescriptors(Converter.prototype);
    delete methods.constructor;
    Object.defineProperties(FormatConverter.prototype, methods);
}

module.exports = FormatConverter;
