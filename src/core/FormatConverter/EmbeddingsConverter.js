/**
 * File: src/core/FormatConverter/EmbeddingsConverter.js
 * Description: OpenAI Embeddings request conversion.
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const FormatConverter = require("./CommonConverter");

class EmbeddingsConverter extends FormatConverter {
    /**
     * Convert OpenAI embeddings request format to Google's OpenAI-compatible embeddings endpoint.
     * @param {object} openaiBody - OpenAI embeddings request body
     * @returns {{ googleRequest: object, cleanModelName: string|null, path: string }}
     */
    translateOpenAIEmbeddingsToGoogle(openaiBody) {
        this.logger.debug(
            "[Adapter] Starting translation of OpenAI embeddings request format to Google OpenAI-compatible format..."
        );

        const googleRequest = openaiBody && typeof openaiBody === "object" ? openaiBody : {};
        const rawModelName = typeof googleRequest.model === "string" ? googleRequest.model : null;
        const cleanModelName = rawModelName ? rawModelName.replace(/^models\//, "") : null;
        const path = "/v1beta/openai/embeddings";

        this.logger.debug(
            `[Adapter] Debug: incoming OpenAI Embeddings Body = ${JSON.stringify(googleRequest, null, 2)}`
        );
        this.logger.debug(`[Adapter] Debug: Final Google OpenAI-compatible Embeddings Path = ${path}`);
        this.logger.debug("[Adapter] OpenAI embeddings to Google OpenAI-compatible translation complete.");

        return { cleanModelName, googleRequest, path };
    }
}

module.exports = EmbeddingsConverter;
