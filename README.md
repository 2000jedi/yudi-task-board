# Task Board Plugin for Obsidian

A powerful Kanban-style task board for Obsidian that automatically organizes tasks from your vault's `tasks` folders. Features include recursive subfolder scanning, tag-based organization, multi-select filtering, and drag-and-drop support.

![Task Board Preview](https://via.placeholder.com/800x400/2a2a2a/ffffff?text=Task+Board+Preview)

## Features

- 📋 **Kanban Board View**: Visual task management with status columns (To Do, In Progress, Done, Archive)
- 🔍 **Recursive Scanning**: Automatically finds tasks in all subfolders of your task directories
- 🏷️ **Tag-Based Organization**: Organize tasks by tags with one click
- 🔘 **Multi-Select Tag Filter**: Filter tasks by multiple tags simultaneously
- 🎯 **Priority Indicators**: Visual priority levels (High, Medium, Low)
- 📂 **Main Tab View**: Opens in the main workspace, not the sidebar
- ⚡ **Quick Actions**: Change status, priority, and open tasks directly from the board
- 🔄 **Auto-Refresh**: Automatically updates when tasks are modified

## Installation

### Manual Installation

1. Download the latest release of the plugin
2. Extract the files to your vault's `.obsidian/plugins/task-board/` folder
3. The folder structure should look like:

   ```
   .obsidian/plugins/task-board/
   ├── main.js
   ├── manifest.json
   └── styles.css
   ```

4. Restart Obsidian
5. Go to **Settings → Community Plugins**
6. Find "Task Board" and click **Enable**

### From Obsidian Community Plugins (Coming Soon)

1. Open Obsidian Settings
2. Go to **Community Plugins**
3. Search for "Task Board"
4. Click **Install**, then **Enable**

## Quick Start

### 1. Create Your First Task

Create a markdown file in any `tasks` folder (or subfolder) with frontmatter:

```markdown
---
status: todo
tag: feature
priority: high
---

# Implement user authentication

Add login and signup functionality to the application.
```

### 2. Open the Task Board

- Click the **📋 layout board icon** in the left ribbon, or
- Run the command: **"Task Board: Open Task Board"** (Ctrl/Cmd + P)

### 3. Organize Your Tasks

Use the toolbar to:

- **Sort** tasks by priority, tag, title, or folder
- **Filter** by multiple tags using the checkbox filter
- **Organize** tasks into folders by tag

## Task File Format

Tasks are markdown files with YAML frontmatter:

```markdown
---
status: todo | in-progress | done | archive
tag: your-tag-name
priority: high | medium | low
---

# Task Title

Task description and details...
```

### Frontmatter Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `status` | No | `todo` | Task status column |
| `tag` | No | `untagged` | Tag for filtering and organization |
| `priority` | No | `medium` | Task priority level |

### Folder Structure Example

```
vault/
├── Project A/
│   └── tasks/
│       ├── feature-request.md
│       └── bug-fix.md
└── Project B/
    └── tasks/
        ├── archive/
        │   └── old-task.md
        └── current/
           └── new-task.md
```

## Using the Task Board

### Board Controls

| Button | Action |
|--------|--------|
| **Sort by** | Choose sort criteria (Priority, Tag, Title, Folder) |
| **↑/↓** | Toggle sort direction (ascending/descending) |
| **📁 Organize** | Move all tasks into folders named after their tags |
| **🔄** | Refresh the board |
| **✕ Clear** | Clear all tag filters |

### Tag Filter

The multi-select tag filter appears below the header:

- **Checkboxes**: Select one or more tags to filter tasks
- **All**: Select all tags (show all tasks)
- **None**: Clear all selections
- **Count**: Shows number of tasks per tag

### Task Card Actions

| Action | How |
|--------|-----|
| **Open task** | Click the task title |
| **Change priority** | Click the colored priority dot (🔴🟡🟢) |
| **Change status** | Right-click the task card |
| **Drag and drop** | Drag card to another column (coming soon) |

### Status Columns

Default columns: **To Do → In Progress → Done → Archive**

Customize in Settings: **Task Board Settings → Status columns**

## Commands

| Command | Description |
|---------|-------------|
| **Task Board: Open Task Board** | Open the task board in main tab |
| **Task Board: Organize tasks by tag** | Move all tasks to tag-based folders |
| **Task Board: Organize tasks in current folder by tag** | Organize tasks in the current file's folder |

## Settings

Access settings at: **Settings → Task Board**

### Task folder names

Names of folders to scan for tasks (comma-separated). Default: `tasks`

Examples:

- `tasks` - Scans any folder named "tasks"
- `tasks, todo, issues` - Scans multiple folder names

### Status columns

Order and names of status columns (comma-separated). Default: `todo, in-progress, done, archive`

### Default status

Status for tasks without frontmatter. Default: `todo`

## Organizing Tasks by Tag

The **"Organize by tag"** feature automatically moves task files into subfolders:

### Before

```
tasks/
├── task1.md (tag: TAG1)
├── task2.md (tag: archive)
└── task3.md (tag: TAG1)
```

### After

```
tasks/
├── TAG1/
│   ├── task1.md
│   └── task3.md
└── archive/
    └── task2.md
```

Use this to keep your task folders organized automatically!

## Tips & Best Practices

1. **Use Consistent Tags**: Stick to a set of standard tags for better filtering
2. **Archive Completed Tasks**: Move done tasks to `archive` status to keep board clean
3. **Use Priorities**: Mark urgent tasks as `high` priority for visibility
4. **Nested Folders**: The plugin scans infinitely deep - organize tasks however you like
5. **Multiple Projects**: Each project can have its own `tasks` folder

## Troubleshooting

### Tasks not appearing?

- Ensure files are in a folder named `tasks` (or your configured folder names)
- Check that files have `.md` extension
- Click the 🔄 refresh button

### Plugin won't enable?

- Check that `main.js`, `manifest.json`, and `styles.css` are in the plugin folder
- Restart Obsidian after manual installation

### Changes not saving?

- Ensure you have write permissions in your vault
- Check Obsidian's file sync status

## Development

### Build from Source

```bash
cd .obsidian/plugins/task-board
npm install
npm run build
```

### Reload Plugin

```bash
obsidian plugin:reload id=task-board
```

## License

MIT License

## Support

- Report issues on GitHub
