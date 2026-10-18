/**
 * File: src/core/RequestHandler/SpeechHandler.js
 * Description: OpenAI-compatible text-to-speech (POST /v1/audio/speech) on Gemini TTS models.
 */

const ModelChannel = require("../ModelChannel");
const PlaygroundCatalog = require("../Playground/Catalog");
const RetryHandler = require("./RetryHandler");
const { pcmFormat, pcmToWav } = require("../../utils/Audio");

// Gemini TTS prebuilt voices; OpenAI voice names map to a similar-sounding one. Other voice names
// (e.g. the 3.8 voices such as Fola or Rami) pass through for the upstream model to validate.
const GEMINI_VOICES = [
    "Achernar",
    "Achird",
    "Algenib",
    "Algieba",
    "Alnilam",
    "Aoede",
    "Autonoe",
    "Callirrhoe",
    "Charon",
    "Despina",
    "Enceladus",
    "Erinome",
    "Fenrir",
    "Gacrux",
    "Iapetus",
    "Kore",
    "Laomedeia",
    "Leda",
    "Orus",
    "Puck",
    "Pulcherrima",
    "Rasalgethi",
    "Sadachbia",
    "Sadaltager",
    "Schedar",
    "Sulafat",
    "Umbriel",
    "Vindemiatrix",
    "Zephyr",
    "Zubenelgenubi",
];
const OPENAI_VOICES = {
    alloy: "Kore",
    ash: "Orus",
    ballad: "Algieba",
    coral: "Aoede",
    echo: "Charon",
    fable: "Puck",
    nova: "Leda",
    onyx: "Fenrir",
    sage: "Sulafat",
    shimmer: "Zephyr",
    verse: "Enceladus",
};
const DEFAULT_VOICE = "Kore";

class SpeechHandler extends RetryHandler {
    static resolveVoice(voice) {
        if (voice === undefined || voice === null || voice === "") return DEFAULT_VOICE;
        const name = typeof voice === "object" ? voice.id : voice;
        const key = String(name ?? "").trim();
        return (
            GEMINI_VOICES.find(known => known.toLowerCase() === key.toLowerCase()) ||
            OPENAI_VOICES[key.toLowerCase()] ||
            (/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) ? key : null)
        );
    }

    /**
     * Validates an OpenAI speech body and builds the Gemini request, or returns an error message.
     * With `voiceStyle`, `instructions` becomes the voice style of a Playground speech block (3.8
     * pages), which the model follows; a prefix in the text would be read aloud by 3.8 models.
     */
    static buildGeminiRequest(body, { voiceStyle = false } = {}) {
        if (!body || typeof body !== "object") return { error: "Request body must be a JSON object." };
        if (typeof body.model !== "string" || !body.model) return { error: "model is required." };
        if (typeof body.input !== "string" || !body.input.trim()) return { error: "input must be a non-empty string." };
        if (body.input.length > 4096) return { error: "input must be at most 4096 characters." };
        const voiceName = SpeechHandler.resolveVoice(body.voice);
        if (!voiceName)
            return {
                error: `Invalid voice "${body.voice}". Use an OpenAI voice name or a Gemini voice name such as ${GEMINI_VOICES.slice(0, 5).join(", ")}.`,
            };
        const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
        return {
            request: {
                contents: [
                    {
                        parts: [
                            voiceStyle && instructions
                                ? { speechMetadata: { style: instructions }, text: body.input }
                                : { text: instructions ? `${instructions}: ${body.input}` : body.input },
                        ],
                        role: "user",
                    },
                ],
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
                },
            },
        };
    }

    /** Raw 16-bit little-endian mono PCM in a WAV container. */
    static pcmToWav(pcm, sampleRate = 24000, channels = 1) {
        return pcmToWav(pcm, sampleRate, channels);
    }

    /** Gemini models return either raw L16 PCM (`audio/L16;rate=24000`) or a WAV file. */
    static toAudio(inlineData, format) {
        const data = Buffer.from(inlineData.data, "base64");
        const mimeType = String(inlineData.mimeType || "").toLowerCase();
        const isWav = mimeType.includes("wav") || data.subarray(0, 4).toString("latin1") === "RIFF";
        if (isWav) {
            if (format !== "pcm") return { body: data, contentType: "audio/wav" };
            // Strip the WAV header to the data chunk for raw PCM output.
            const dataOffset = data.indexOf("data", 12, "latin1");
            return { body: dataOffset >= 0 ? data.subarray(dataOffset + 8) : data, contentType: "audio/pcm" };
        }
        const { channels, sampleRate: rate } = pcmFormat(mimeType);
        if (format === "pcm") return { body: data, contentType: `audio/pcm;rate=${rate}` };
        return { body: SpeechHandler.pcmToWav(data, rate, channels), contentType: "audio/wav" };
    }

    async processOpenAISpeechRequest(req, res) {
        const requestId = this._generateRequestId();
        this._startTrackedRequest(requestId, req, {
            apiFormat: "openai",
            isStreaming: false,
            requestCategory: "generation",
            streamMode: null,
        });
        this._setResponseApiFormat(res, "openai");
        res.__proxyResponseStreamMode = null;

        try {
            const target = ModelChannel.parse(req.body?.model);
            const { error, request } = SpeechHandler.buildGeminiRequest(req.body, {
                voiceStyle:
                    target.channel === "playground" &&
                    PlaygroundCatalog.usesSpeechBlocks(
                        this.formatConverter.constructor.stripModelSuffixes(target.model)
                    ),
            });
            if (error) return this._sendErrorResponse(res, 400, error, "invalid_request_error");
            // OpenAI defaults to mp3; Gemini only produces PCM/WAV, so every non-PCM format is served as WAV.
            const format = req.body.response_format === "pcm" ? "pcm" : "wav";
            if (!(await this._ensureBrowserBackedRequestReady(res, { waitErrorType: "service_unavailable" }))) return;
            this.authSwitcher.incrementUsageCount();
            if (this.authSwitcher.shouldSwitchByUsage()) this.needsSwitchingAfterRequest = true;

            const model = this.formatConverter.constructor.stripModelSuffixes(req.body.model);
            const proxyRequest = {
                body: JSON.stringify(request),
                headers: { "Content-Type": "application/json" },
                is_generative: true,
                method: "POST",
                path: `/v1beta/models/${model}:generateContent`,
                query_params: {},
                request_id: requestId,
                streaming_mode: "fake",
            };
            this._initializeProxyRequestAttempt(proxyRequest);
            this._updateTrackedRequest(requestId, { model, path: proxyRequest.path, requestCategory: "generation" });

            try {
                const messageQueue = this.connectionRegistry.createMessageQueue(
                    requestId,
                    this._selectDispatchAuthIndex(),
                    proxyRequest.request_attempt_id
                );
                this._setupClientDisconnectHandler(res, requestId);
                const result = await this._executeRequestWithRetries(proxyRequest, messageQueue, res);
                if (!result.success) {
                    this._logFinalRequestFailure(result.error, "OpenAI speech", requestId);
                    this._sendErrorResponse(res, result.error.status || 500, result.error.message);
                    const accountSwitchTask = this._handleFinalFailureAccountSwitch(result.error, {
                        connectionResetContext: "OpenAI speech",
                    });
                    if (accountSwitchTask) await accountSwitchTask;
                    return;
                }
                if (this.authSwitcher.failureCount > 0) this.authSwitcher.failureCount = 0;

                let fullBody = "";
                for (;;) {
                    const message = await result.queue.dequeue(this.timeouts.FAKE_STREAM);
                    if (message.type === "STREAM_END") break;
                    if (message.event_type === "error")
                        return this._sendErrorResponse(res, this._getUpstreamErrorStatus(message), message.message);
                    if (message.event_type === "chunk" && message.data) fullBody += message.data;
                }
                let response;
                try {
                    response = JSON.parse(fullBody);
                } catch {
                    return this._sendErrorResponse(res, 502, "Failed to parse backend response");
                }
                const candidate = response.candidates?.[0];
                const audio = candidate?.content?.parts?.find(part => part?.inlineData?.data)?.inlineData;
                if (!audio) {
                    const reason = response.promptFeedback?.blockReason || candidate?.finishReason || "no audio";
                    return this._sendErrorResponse(res, 502, `The model returned no audio (${reason}).`);
                }
                const { body, contentType } = SpeechHandler.toAudio(audio, format);
                res.status(200).set({ "Content-Length": body.length, "Content-Type": contentType }).end(body);
                this.logger.info(`✅ [Request] Response completed (OpenAI speech), request ID: ${requestId}`);
            } catch (error) {
                this._handleQueueTimeout(error, requestId);
                this._handleRequestError(error, res, requestId);
            } finally {
                this._cleanupRequestResources(requestId, res, { switchAccountIfNeeded: true });
            }
        } finally {
            this._finalizeTrackedRequest(requestId, res);
        }
    }
}

module.exports = SpeechHandler;
