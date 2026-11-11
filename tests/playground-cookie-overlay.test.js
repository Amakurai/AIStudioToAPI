const test = require("node:test");
const assert = require("node:assert/strict");
const { firefox } = require("playwright");
const PlaygroundSession = require("../src/core/Playground/Session");

const executablePath = process.env.PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH;
const browserTest = executablePath ? test : test.skip;
const RPC =
    "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent";

// No Google login or network is needed: exercise real Playwright pointer interception,
// page reuse and the session's native-envelope capture against a local UI fixture.
async function fixture(t, { speech = false, upgrade = false, decoy = false } = {}) {
    const browser = await firefox.launch({ executablePath, headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    const html = `<!doctype html>
        <style>
            .glue-cookie-notification-bar {
                position: fixed; inset: 0; z-index: 99999; background: white;
            }
        </style>
        <button id="new">New chat</button>
        ${speech ? '<button id="create">Create new dialog</button>' : ""}
        <textarea aria-label="${speech ? "Speech block text" : "Enter a prompt"}"
            ${speech ? "hidden" : ""}></textarea>
        <button id="run">Run</button>
        ${decoy ? "<p>Gemini 4 Argon needs a Google AI plan or a Gemini API key.</p>" : ""}
        <script>
            const showNotice = () => {
                const notice = document.createElement('div');
                notice.className = 'glue-cookie-notification-bar visible';
                notice.setAttribute('role', 'region');
                // Deliberately no English dismissal button.
                notice.textContent = 'Cookie 提示';
                document.body.append(notice);
            };
            const input = document.querySelector('textarea');
            input.addEventListener('input', showNotice);
            document.getElementById('new').onclick = () => {
                input.value = '';
                showNotice();
            };
            ${speech ? "document.getElementById('create').onclick = () => { input.hidden = false; }; showNotice();" : ""}
            document.getElementById('run').onclick = () => {
                document.body.dataset.submissions = Number(document.body.dataset.submissions || 0) + 1;
                ${
                    upgrade
                        ? `setTimeout(() => {
                            const dialog = document.createElement('ms-upgrade-options-dialog');
                            dialog.innerHTML = '<p>Gemini 4 Argon needs a Google AI plan or a Gemini API key.</p>';
                            document.body.append(dialog);
                        }, 100);`
                        : `fetch(${JSON.stringify(RPC)}, {
                            method: 'POST',
                            body: JSON.stringify([
                                'models/${speech ? "gemini-3.8-flash-tts" : "gemini-4-argon"}',
                                [[[[null, input.value]], 'user']], null, []
                            ])
                        }).catch(() => {});`
                }
            };
        </script>`;
    const newPage = context.newPage.bind(context);
    const session = new PlaygroundSession(context, () => {});
    const counts = { inferences: 0, navigations: 0 };
    context.newPage = async () => {
        const page = await newPage();
        const addRoute = page.route.bind(page);
        page.route = (pattern, handler) =>
            addRoute(pattern, async route => {
                if (route.request().isNavigationRequest()) {
                    counts.navigations++;
                    return route.fulfill({ body: html, contentType: "text/html" });
                }
                if (route.request().url() === RPC && !session.capture) {
                    counts.inferences++;
                    return route.fulfill({ body: "[]", contentType: "application/json" });
                }
                return handler(route);
            });
        return page;
    };
    const request = () =>
        session.request(
            speech ? "gemini-3.8-flash-tts" : "gemini-4-argon",
            { contents: [{ parts: [{ text: "Hi" }], role: "user" }] },
            { onData() {}, signal: new AbortController().signal, timeoutMs: 5000 }
        );
    return { counts, newPage, request, session };
}

browserTest("fixture reproduces a cookie overlay intercepting Run", async t => {
    const { newPage } = await fixture(t);
    const page = await newPage();
    await page.setContent(`
        <button>Run</button>
        <div class="glue-cookie-notification-bar"
            style="position:fixed;inset:0;z-index:99999">Cookie 提示</div>
    `);
    await assert.rejects(
        page.getByRole("button", { name: "Run" }).click({ timeout: 500 }),
        /intercepts pointer events/
    );
});

browserTest("late cookie overlays cannot block Run or a reused session", async t => {
    const { counts, request, session } = await fixture(t);
    await request();
    await request();
    assert.equal(counts.navigations, 1, "New chat should reuse the page despite the reappearing banner");
    assert.equal(counts.inferences, 2, "each request must reach inference exactly once");
    assert.equal(await session.page.locator("body").getAttribute("data-submissions"), "2");
    assert.equal(await session.page.locator(".glue-cookie-notification-bar:visible").count(), 0);
});

browserTest("cookie overlays cannot block speech dialog creation or Run", async t => {
    const { counts, request, session } = await fixture(t, { speech: true });
    await request();
    assert.equal(counts.inferences, 1);
    assert.equal(await session.page.locator("body").getAttribute("data-submissions"), "1");
    assert.equal(await session.page.locator(".glue-cookie-notification-bar:visible").count(), 0);
});

browserTest("an asynchronously displayed upgrade dialog fails before inference", async t => {
    const { counts, request, session } = await fixture(t, { upgrade: true });
    await assert.rejects(request(), error => error.status === 403 && /access verification/.test(error.message));
    assert.equal(counts.inferences, 0);
    assert.equal(session.page.isClosed(), true);
});

browserTest("upgrade wording outside the dialog does not block a normal request", async t => {
    const { counts, request } = await fixture(t, { decoy: true });
    await request();
    assert.equal(counts.inferences, 1);
});
