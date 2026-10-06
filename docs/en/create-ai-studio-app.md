# Create an AI Studio App

This guide creates a dedicated AI Studio App for the project and obtains the app link required by the `AI_STUDIO_APP_URL` environment variable.

## 1. Open the blank app

Sign in to your Google account, then open the [AI Studio blank app](https://aistudio.google.com/apps/bundled/blank).

Click **Remix** in the upper-right corner. Do not use the Remix button beside the prompt box in the lower-left corner.

![Click Remix in the upper-right corner](../assets/ai-studio-app/01-remix.png)

## 2. Create your copy

Change the **App name** in the dialog. You may also update the **Description**. Then click **Remix app** in the lower-right corner.

![Enter an app name and click Remix app](../assets/ai-studio-app/02-remix-dialog.png)

Wait for the copy to be created. After your app name appears at the top, click **Code** above the preview area to open the code editor.

![Click Code to open the editor](../assets/ai-studio-app/03-code.png)

## 3. Replace the app files

Replace the complete contents of these files in the code editor:

1. Open `index.ts` in the AI Studio App, delete its existing contents, then copy and paste the complete contents of this project's [`scripts/client/build.js`](../../scripts/client/build.js).
2. Open `index.html` in the AI Studio App, delete its existing contents, then copy and paste the complete contents of this project's [`scripts/client/index.html`](../../scripts/client/index.html).

Click **Save** at the bottom of the editor when finished. You can also press `Ctrl+S` (`Command+S` on macOS).

> Copy the files from the version of the repository you are currently using. If a future project update changes either file, replace the corresponding App file again and save it.

## 4. Check the preview

Click **Preview** above the preview area and wait about 10 seconds. The following error means the client code is running and waiting for this project to establish a connection; it is expected here:

```text
Error: ❌ Failed to get authIndex: authIndex postMessage timeout (10s)
```

![Expected timeout message in Preview](../assets/ai-studio-app/04-preview-error.png)

AI Studio may also show a code error count on the left or at the bottom. Do not click **Fix** and let AI rewrite the code. You can continue as long as Preview displays the `authIndex postMessage timeout (10s)` message above.

## 5. Share publicly and copy the link

1. Click **Share** in the upper-right corner. You do not need to click **Publish**.
2. Under **General access**, select **Public: Anyone with the link can view**.
3. Click **Copy link** at the bottom of the sharing panel.

![Set access to Public and copy the link](../assets/ai-studio-app/05-share.png)

The copied link should look like this:

```text
https://ai.studio/apps/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

## 6. Configure the environment variable

Add the complete link to the `.env` file in the project root:

```env
AI_STUDIO_APP_URL=https://ai.studio/apps/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Save `.env` and restart AIStudioToAPI. The `AI Studio App URL` entry in the startup log should show the URL you configured.

> The App must remain Public, or the Google account running AIStudioToAPI may be unable to open it. A public link also allows anyone who has it to view the App, so never add API keys, cookies, or other secrets to `index.ts` or `index.html`.
