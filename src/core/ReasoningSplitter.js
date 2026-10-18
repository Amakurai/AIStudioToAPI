/**
 * Splits an anti-truncation reply that opens with a `<thinking>` or `<think>` block into reasoning
 * and answer text, so clients receive the block in their native reasoning field.
 *
 * Prompt presets often have the model think inside such a block, and clients such as SillyTavern
 * end it at the first closing tag. Models sometimes quote the tags inside their own thinking
 * ("`<thinking>…</thinking>` 工作日志"), which leaks the rest of the thinking into the answer. Here
 * a closing tag is a quoted mention, not the end, when it directly follows a backtick or closes an
 * opening tag written earlier on the same line. Every decision depends only on text already
 * received, so streamed output is never taken back.
 */
class ReasoningSplitter {
    static TAGS = ["thinking", "think"];

    /**
     * Where the reasoning block of `text` ends. Returns null while the start is still undecided,
     * `{ plain: true }` for replies without a leading block, or the block's bounds: `start` (after the
     * opening tag), `close` (the real closing tag, or null while it has not arrived), `answer` (after
     * the closing tag) and `safe` (how far an unclosed block can be emitted without splitting a tag).
     */
    static analyze(text, final = false) {
        const lead = text.length - text.trimStart().length;
        const rest = text.slice(lead);
        for (const tag of this.TAGS) {
            if (!rest.startsWith(`<${tag}>`)) continue;
            const start = lead + tag.length + 2;
            const close = this.findClose(text, tag, start);
            if (close >= 0) return { answer: close + tag.length + 3, close, start };
            // A reply that ends inside the block is all reasoning, as the client would show it.
            if (final) return { answer: text.length, close: text.length, start };
            const closing = `</${tag}>`;
            let held = Math.min(closing.length - 1, text.length - start);
            while (held > 0 && !text.endsWith(closing.slice(0, held))) held--;
            return { answer: null, close: null, safe: text.length - held, start };
        }
        if (!final && this.TAGS.some(tag => `<${tag}>`.startsWith(rest))) return null;
        return { plain: true };
    }

    static findClose(text, tag, start) {
        const opening = `<${tag}>`;
        const closing = `</${tag}>`;
        const count = (line, token) => line.split(token).length - 1;
        for (let index = text.indexOf(closing, start); index >= 0; index = text.indexOf(closing, index + 1)) {
            const line = text.slice(Math.max(start, text.lastIndexOf("\n", index - 1) + 1), index);
            const quoted = line.endsWith("`") || count(line, opening) > count(line, closing);
            if (!quoted) return index;
        }
        return -1;
    }

    /** Splits a complete reply; returns null when it does not open with a reasoning block. */
    static split(text) {
        const block = this.analyze(text, true);
        if (block.plain) return null;
        return {
            answer: text.slice(block.answer).trimStart(),
            reasoning: text.slice(block.start, block.close).trimStart(),
        };
    }

    constructor() {
        this.text = "";
        this.sent = 0;
        this.reasoningBegun = false;
        this.answerBegun = false;
    }

    /**
     * Adds streamed reply text and returns the pieces that are safe to emit, as `{ text }` answer
     * pieces or `{ text, thought: true }` reasoning pieces. `final` flushes anything held back. The
     * pieces of one reply always join to the same reasoning and answer as `split()`.
     */
    push(chunk, final = false) {
        this.text += chunk;
        const block = ReasoningSplitter.analyze(this.text, final);
        const pieces = [];
        if (!block) return pieces;
        if (block.plain) {
            if (this.text.length > this.sent) pieces.push({ text: this.text.slice(this.sent) });
            this.sent = this.text.length;
            return pieces;
        }
        // Leading whitespace of the reasoning and the answer is dropped, matching split().
        const emit = (from, end, thought) => {
            if (end <= Math.max(from, this.sent)) return;
            let piece = this.text.slice(Math.max(from, this.sent), end);
            this.sent = end;
            const begun = thought ? "reasoningBegun" : "answerBegun";
            if (!this[begun]) piece = piece.trimStart();
            if (!piece) return;
            this[begun] = true;
            pieces.push(thought ? { text: piece, thought: true } : { text: piece });
        };
        emit(block.start, block.close ?? block.safe, true);
        if (block.close !== null) emit(block.answer, this.text.length, false);
        return pieces;
    }
}

module.exports = ReasoningSplitter;
