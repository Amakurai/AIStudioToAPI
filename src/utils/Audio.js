/**
 * File: src/utils/Audio.js
 * Description: Audio helpers for Gemini speech output (raw L16 PCM or WAV).
 */

/** Raw 16-bit little-endian PCM in a WAV container. */
function pcmToWav(pcm, sampleRate = 24000, channels = 1) {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channels * 2, 28);
    header.writeUInt16LE(channels * 2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

/** Sample rate and channel count from a mime type such as `audio/L16;codec=pcm;rate=24000`. */
function pcmFormat(mimeType) {
    const value = String(mimeType || "").toLowerCase();
    return {
        channels: Number(value.match(/channels=(\d+)/)?.[1]) || 1,
        sampleRate: Number(value.match(/rate=(\d+)/)?.[1]) || 24000,
    };
}

function isRawPcm(mimeType) {
    return /^audio\/(?:l16|pcm)\b/i.test(String(mimeType || ""));
}

/**
 * Browsers cannot play raw PCM, so inline raw PCM output becomes a WAV file; other media is unchanged.
 * @returns {{ data: string, mimeType: string }} Base64 data and its mime type.
 */
function playableInlineData(inlineData) {
    if (!isRawPcm(inlineData?.mimeType) || typeof inlineData.data !== "string") return inlineData;
    const { channels, sampleRate } = pcmFormat(inlineData.mimeType);
    const wav = pcmToWav(Buffer.from(inlineData.data, "base64"), sampleRate, channels);
    return { data: wav.toString("base64"), mimeType: "audio/wav" };
}

module.exports = { isRawPcm, pcmFormat, pcmToWav, playableInlineData };
