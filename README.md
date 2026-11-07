# YouTube Full Height for Chrome

Give a playing YouTube video its own full-height window, switch it to picture-in-picture, or return it to a normal tab. Full Height moves the existing tab, so playback continues in the same player.

[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/youtube-full-height-for-c/jejofoanpemjhpbkgegipamefepamojd)

## Features

- **Full height:** opens the playing tab in a centered popup sized for the screen without stretching or cropping the video.
- **Picture-in-picture:** opens the current player in a floating Document Picture-in-Picture window when supported by Chromium.
- **Return to tab:** puts the player back in a normal browser tab.
- **Automatic mode:** opens playing YouTube videos in Full Height by default; switch it off in the extension popup for manual control.

The hover controls on the video provide the mode switches. The extension popup also offers a Full Height button and the automatic-mode setting.

## Install from source

1. Use Chrome or Chromium 130 or later.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select this repository folder (the one containing `manifest.json`).

No build step is required. This repository tracks the local extension source; the Chrome Web Store release may have a different version.

## Permissions

The extension uses browser storage for its settings and requests access only to `https://www.youtube.com/*`. Its background worker and content scripts manage the video window and mode controls.

## Platform notes

Chrome controls popup window placement on Windows and macOS. On Linux, your window manager may tile new popup windows; floating and centering behavior can depend on its configuration. Document Picture-in-Picture availability also depends on the browser and page.

## Development

The extension is plain JavaScript, CSS, and HTML with a Manifest V3 `manifest.json`. Load this folder unpacked, then use **Reload** on `chrome://extensions` after editing source files.
