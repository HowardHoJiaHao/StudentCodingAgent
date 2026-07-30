# Howard Agent — setup

Send this to a student along with two things: the `.vsix` file, and their key.

You need **VS Code**. Nothing else — no Node, no npm, no terminal.

---

## 1. Install the extension

Save `howard-agent-0.1.0.vsix` somewhere you can find it, then in VS Code:

`Ctrl+Shift+P` → type **Install from VSIX** → Enter → pick the file.

<sub>Mac: `Cmd+Shift+P`. Or: Extensions sidebar → `...` menu at the top → *Install from VSIX…*</sub>

Reload VS Code when it asks.

## 2. Sign in with your key

`Ctrl+Shift+P` → type **Howard Agent: Sign In** → Enter → paste your key.

It looks like `sk-` followed by random characters. It is stored in your
operating system's keychain, not in a file.

## 3. Open a project folder

**File → Open Folder** and pick the folder you want to work in.

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
| Nothing happens | Check your internet, then reload the window |

## One thing to know

Shell commands the agent runs are **not** restricted to your project folder —
they run with your normal user permissions, like anything you'd type in a
terminal yourself. File edits *are* confined to the folder you opened. Read
command prompts before allowing them, especially anything that deletes.
