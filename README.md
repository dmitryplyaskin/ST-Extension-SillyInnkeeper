# SillyInnkeeper (SillyTavern Extension)

A **SillyTavern** extension that acts as a bridge to **SillyInnkeeper**.

It is designed to bring SillyInnkeeper’s features into SillyTavern and create a more seamless workflow: when you interact with cards inside SillyInnkeeper, SillyTavern can automatically receive and import them.

Main SillyInnkeeper repository: [SillyInnkeeper](https://github.com/dmitryplyaskin/SillyInnkeeper)

## Features

- Seamless integration between SillyInnkeeper and SillyTavern
- Automatic import of character cards from SillyInnkeeper into SillyTavern
- Automatically refreshes the character list so imported cards appear immediately
- Optional: automatically open the imported character after import

## Installation

This is a third-party extension.

1. Close SillyTavern.
2. Copy this folder to:
   `SillyTavern/public/scripts/extensions/third-party/ST-Extension-SillyInnkeeper/`
   Make sure the folder contains `manifest.json`.
3. Start SillyTavern.
4. Open **Extensions** and enable **SillyInnkeeper**.
5. If the settings UI does not appear, do a hard refresh (e.g. `Ctrl+F5`).

## Quick start

1. Start SillyInnkeeper.
2. In SillyTavern open **Extensions → SillyInnkeeper**.
3. Set the **SillyInnkeeper URL** (default is `http://127.0.0.1:48912`).
4. Keep **Auto-connect** enabled (recommended).
5. Use SillyInnkeeper as usual — when SillyInnkeeper triggers card playback, the card will be imported into SillyTavern.

## Settings

Open **Extensions → SillyInnkeeper**:

- **Enable extension**: master on/off switch for the bridge.
- **SillyInnkeeper URL**: where your SillyInnkeeper instance is running.
- **Auto-connect**: automatically connects when SillyTavern is ready.
- **Report import result back to SillyInnkeeper (optional)**: sends a success/failure status back to SillyInnkeeper after import.
- **Open imported character**: after a successful import, automatically open the imported character in SillyTavern.

## Author

Dmitry Plyaskin
