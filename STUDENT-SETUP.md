# Howard Agent — setup

Send this to a student along with two things: the `.vsix` file, and their key.

You need **VS Code**. Nothing else — no Node, no npm, no terminal.

---

## 1. Install the extension

The `.vsix` file is an add-on for VS Code, like an extension for your web
browser. It isn't a separate program: once installed, it lives inside VS Code.

Save `howard-agent-0.1.0.vsix` somewhere you can find it, then in VS Code:

`Ctrl+Shift+P` → choose **Extensions: Install from VSIX...** (typing
`Install from VSIX` finds it) → Enter → pick the file.

<sub>Mac: `Cmd+Shift+P`. Or: Extensions sidebar → `...` menu at the top → *Install from VSIX…*</sub>

Reload VS Code when it asks.

## 2. Sign in with your key

`Ctrl+Shift+P` → type **Howard Agent: Sign In** → Enter → paste your key.

It looks like `sk-` followed by random characters. It is stored in your
operating system's keychain, not in a file.

## 3. Open a project folder

**File → Open Folder** and pick the folder you want to work in.

If VS Code asks whether you trust the authors of the files, choose **Yes, I
trust the authors**. The agent is switched off in Restricted Mode.

The agent can only read and edit files **inside the folder you open**, so open
the project you're working on — not your whole drive.

## 4. Start

Click the **`< • >`** icon in the bar down the left-hand side. The chat opens
as a tab. Ask it something:

> explain what bubbleSort.c does
>
> add a function that reverses a string, and compile it to check

---

## What to expect

- It reads and edits files in your folder, and can run commands
- **It asks before changing anything.** Read the prompt before clicking Allow
- The bar above the message box shows every file it changed, with **Undo**
- The bottom right shows how much budget you have left

## Commands

`Ctrl+Shift+P` → type **Howard** to see them all:

| Command | What it does |
|---|---|
| **Howard Agent: Sign In (Set Key)** | Paste your key. VS Code remembers it. |
| **Howard Agent: Sign Out** | Removes your saved key and clears the chat |
| **Howard Agent: New Chat** | Starts a fresh conversation, which is cheaper |
| **Howard Agent: Open Chat in Editor** | Opens the chat as a tab instead of in the sidebar |

New Chat and Open Chat in Editor are also buttons at the top of the chat panel.

## Updating or removing it

- **New version:** when you get a new `.vsix` file, install it the same way as
  in step 1. It replaces the old one, and you stay signed in.
- **Uninstall:** open the Extensions panel (`Ctrl+Shift+X`), find **Howard
  Agent**, click the gear, then **Uninstall**.

## Your budget

Your key has a spending limit that resets every 30 days. When it runs low the
figure turns orange, then red. Once it's gone, requests fail until it resets or
your budget is topped up.

Long conversations cost more than short ones, because the whole conversation is
re-sent each time. **Howard Agent: New Chat** starts fresh and is cheaper — use
it when you switch to an unrelated task.

## Your key is yours

Don't share it or post it anywhere. Anyone who has it spends your budget.
If it leaks, ask for a new one — it can be revoked on its own.

## If something breaks

| Problem | Fix |
|---|---|
| "Key rejected" | Re-run **Howard Agent: Sign In** and paste it again |
| "Budget used up" | Ask for a top-up |
| "Open a folder first" | Step 3 — the agent needs a folder |
| No `< • >` icon | Reload VS Code (`Ctrl+Shift+P` → *Reload Window*) |
| "Restricted Mode" at the bottom left, agent does nothing | Click **Restricted Mode** → **Trust** |
| First reply takes a long time | The server was asleep and is waking up. Wait — the next replies are faster |
| Nothing happens | Check your internet, then reload the window |

## One thing to know

Shell commands the agent runs are **not** restricted to your project folder —
they run with your normal user permissions, like anything you'd type in a
terminal yourself. File edits *are* confined to the folder you opened. Read
command prompts before allowing them, especially anything that deletes.
