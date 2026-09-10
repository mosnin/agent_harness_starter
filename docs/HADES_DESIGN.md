# Hades desktop design

Hades should feel like a quiet Mac utility with an independent streak. The interface uses system fonts, warm neutral surfaces, thin dividers, a restrained red accent and small SF Mono / Menlo labels. The conversation is the primary surface; files, Git and terminals sit beside it. Empty states describe the next useful action. No demo projects, fabricated metrics or stock dashboard charts are seeded.

The original app mark combines a rough red H with terminal brackets on charcoal. The user supplied a red punk lettering reference; the artwork borrows its brush texture, not its wording or composition. Generated with the built-in image-generation tool on 2026-09-06. Source: `src/desktop/assets/hades-icon.png`. Packaged icon: `src-tauri/icons/icon.icns`. `scripts/macos-icon.swift` prepares the iconset using AppKit.

Generation prompt: “Create an original logo for HADES, a beautifully minimal macOS AI agent app. Use the attached image only as a reference for rough expressive red paint lettering, not its wording or layout. One square app icon, charcoal background, large vermilion hand-painted capital H, dry-brush edges, two thin broken angular terminal brackets, plenty of negative space. No mockup, extra text, gradients, 3D, flames or skulls.”

Interaction rules: keyboard shortcuts, visible focus, modal focus containment, reduced-motion support, explicit process/approval state, interruptible agent turns, and copy/preview controls close to the content. The Mac shell preserves the native titlebar and traffic lights. External sites receive no native application permissions.

References used: Apple Design skill; Tauri 2 configuration and global shortcut documentation; xterm.js terminal API. See `HERMES_DESKTOP_PARITY.md` for the product capability comparison.

The next desktop pass adds Local models, Team rooms and Extensions to the same navigation. Model inventory uses ordinary rows with download progress; rooms use the existing conversation typography; checkpoint review compares two plain text panels. Theme imports map validated VS Code colors onto existing surface tokens. Shortcuts are editable in a compact form, with system editing keys reserved. Native light/dark conversation views, installed local models and the Team rooms empty state were inspected and captured. No sample projects or fabricated agent conversations were seeded.
