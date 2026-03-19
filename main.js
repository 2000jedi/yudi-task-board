"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const obsidian_1 = require("obsidian");
const DEFAULT_SETTINGS = {
    taskFolders: ['tasks'],
    statusOrder: ['todo', 'in-progress', 'done', 'archive'],
    defaultStatus: 'todo',
    sortBy: 'priority',
    sortDirection: 'desc',
    organizeByTag: false,
    hiddenStatuses: []
};
const VIEW_TYPE_TASK_BOARD = 'task-board-view';
// Main Plugin Class
class TaskBoardPlugin extends obsidian_1.Plugin {
    async onload() {
        await this.loadSettings();
        // Register the custom view
        this.registerView(VIEW_TYPE_TASK_BOARD, (leaf) => new TaskBoardView(leaf, this));
        // Add ribbon icon
        this.addRibbonIcon('layout-board', 'Open Task Board', () => {
            this.activateView();
        });
        // Add command - Open Task Board
        this.addCommand({
            id: 'open-task-board',
            name: 'Open Task Board',
            callback: () => {
                this.activateView();
            }
        });
        // Add command - Organize tasks by tag
        this.addCommand({
            id: 'organize-tasks-by-tag',
            name: 'Organize tasks by tag',
            callback: async () => {
                await this.organizeTasksByTag();
            }
        });
        // Add command - Organize tasks in current folder
        this.addCommand({
            id: 'organize-tasks-in-current-folder',
            name: 'Organize tasks in current folder by tag',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (file) {
                    if (!checking) {
                        const folder = file.parent;
                        if (folder) {
                            this.organizeTasksInFolder(folder);
                        }
                    }
                    return true;
                }
                return false;
            }
        });
        // Add settings tab
        this.addSettingTab(new TaskBoardSettingTab(this.app, this));
        // Refresh view when files change
        this.registerEvent(this.app.vault.on('create', () => this.refreshView()));
        this.registerEvent(this.app.vault.on('delete', () => this.refreshView()));
        this.registerEvent(this.app.vault.on('rename', () => this.refreshView()));
        this.registerEvent(this.app.metadataCache.on('changed', () => this.refreshView()));
    }
    onunload() {
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_TASK_BOARD);
    }
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }
    async saveSettings() {
        await this.saveData(this.settings);
        this.refreshView();
    }
    async activateView() {
        const { workspace } = this.app;
        let leaf = null;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_TASK_BOARD);
        if (leaves.length > 0) {
            leaf = leaves[0];
        }
        else {
            // Create in main view area instead of sidebar
            leaf = workspace.getLeaf('tab');
            await leaf.setViewState({ type: VIEW_TYPE_TASK_BOARD, active: true });
        }
        workspace.revealLeaf(leaf);
    }
    refreshView() {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASK_BOARD);
        for (const leaf of leaves) {
            const view = leaf.view;
            view.refresh();
        }
    }
    // Recursively collect all markdown files from a folder and its subfolders
    collectMarkdownFiles(folder) {
        const files = [];
        for (const child of folder.children) {
            if (child instanceof obsidian_1.TFile && child.extension === 'md') {
                files.push(child);
            }
            else if (child instanceof obsidian_1.TFolder) {
                // Recursively get files from subfolders
                files.push(...this.collectMarkdownFiles(child));
            }
        }
        return files;
    }
    // Scan all task folders and return tasks (including subfolders)
    async scanTasks() {
        const tasks = [];
        const vault = this.app.vault;
        // Get all folders in vault
        const allFolders = vault.getAllLoadedFiles()
            .filter(f => f instanceof obsidian_1.TFolder);
        // Find task folders (exact matches or folders ending with /tasks, etc.)
        const taskFolders = [];
        for (const folder of allFolders) {
            if (this.settings.taskFolders.some(tf => folder.path === tf ||
                folder.path.endsWith('/' + tf) ||
                folder.name === tf)) {
                taskFolders.push(folder);
            }
        }
        // Scan each task folder recursively
        for (const folder of taskFolders) {
            // Recursively collect all markdown files including subfolders
            const files = this.collectMarkdownFiles(folder);
            for (const file of files) {
                const task = await this.parseTaskFile(file, folder);
                if (task) {
                    tasks.push(task);
                }
            }
        }
        return tasks;
    }
    // Parse a task file and extract metadata
    async parseTaskFile(file, folder) {
        try {
            const cache = this.app.metadataCache.getFileCache(file);
            const frontmatter = cache?.frontmatter;
            // Read file content for title (first line or h1)
            const content = await this.app.vault.read(file);
            let title = file.basename;
            // Try to find a better title from content
            const lines = content.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('---')) {
                    if (trimmed.startsWith('# ')) {
                        title = trimmed.substring(2).trim();
                    }
                    break;
                }
            }
            // Get parent folder name as category
            const folderParts = folder.path.split('/');
            const parentFolder = folderParts.length > 1 ? folderParts[folderParts.length - 2] : 'Root';
            return {
                id: file.path,
                file: file,
                title: title,
                status: frontmatter?.status || this.settings.defaultStatus,
                tag: frontmatter?.tag || 'untagged',
                priority: (frontmatter?.priority || 'medium'),
                content: content,
                folder: parentFolder
            };
        }
        catch (error) {
            console.error('Error parsing task file:', file.path, error);
            return null;
        }
    }
    // Update task status
    async updateTaskStatus(task, newStatus) {
        try {
            const cache = this.app.metadataCache.getFileCache(task.file);
            const frontmatter = cache?.frontmatter;
            if (frontmatter) {
                // Update frontmatter
                const content = await this.app.vault.read(task.file);
                const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
                const match = content.match(frontmatterRegex);
                if (match) {
                    let newFrontmatter = match[1];
                    // Replace status line
                    newFrontmatter = newFrontmatter.replace(/status:\s*\w+/, `status: ${newStatus}`);
                    // If status doesn't exist, add it
                    if (!newFrontmatter.includes('status:')) {
                        newFrontmatter = `status: ${newStatus}\n${newFrontmatter}`;
                    }
                    const newContent = content.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
                    await this.app.vault.modify(task.file, newContent);
                }
            }
            else {
                // Add frontmatter if it doesn't exist
                const newFrontmatter = `---\nstatus: ${newStatus}\ntag: ${task.tag}\npriority: ${task.priority}\n---\n\n`;
                await this.app.vault.modify(task.file, newFrontmatter + task.content);
            }
            task.status = newStatus;
            new obsidian_1.Notice(`Task moved to ${newStatus}`);
        }
        catch (error) {
            console.error('Error updating task status:', error);
            new obsidian_1.Notice('Failed to update task status');
        }
    }
    // Update task priority
    async updateTaskPriority(task, newPriority) {
        try {
            const content = await this.app.vault.read(task.file);
            const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
            const match = content.match(frontmatterRegex);
            if (match) {
                let newFrontmatter = match[1];
                newFrontmatter = newFrontmatter.replace(/priority:\s*\w+/, `priority: ${newPriority}`);
                if (!newFrontmatter.includes('priority:')) {
                    newFrontmatter = newFrontmatter.replace(/(status:[^\n]*)/, `$1\npriority: ${newPriority}`);
                }
                const newContent = content.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
                await this.app.vault.modify(task.file, newContent);
                task.priority = newPriority;
            }
        }
        catch (error) {
            console.error('Error updating task priority:', error);
        }
    }
    // Organize all tasks by tag - moves files into subfolders named after their tags
    async organizeTasksByTag() {
        const tasks = await this.scanTasks();
        const tasksByTag = new Map();
        // Group tasks by tag
        for (const task of tasks) {
            const tag = task.tag || 'untagged';
            if (!tasksByTag.has(tag)) {
                tasksByTag.set(tag, []);
            }
            tasksByTag.get(tag).push(task);
        }
        let movedCount = 0;
        const vault = this.app.vault;
        // Process each tag group
        for (const [tag, tagTasks] of tasksByTag) {
            for (const task of tagTasks) {
                // Skip if already in correct folder
                const currentFolder = task.file.parent?.name;
                if (currentFolder === tag)
                    continue;
                // Determine destination folder
                const baseFolder = this.findBaseTaskFolder(task.file);
                if (!baseFolder)
                    continue;
                const targetFolderPath = `${baseFolder.path}/${tag}`;
                try {
                    // Create target folder if it doesn't exist
                    let targetFolder = vault.getAbstractFileByPath(targetFolderPath);
                    if (!targetFolder) {
                        await vault.createFolder(targetFolderPath);
                        targetFolder = vault.getAbstractFileByPath(targetFolderPath);
                    }
                    if (targetFolder instanceof obsidian_1.TFolder) {
                        const newPath = `${targetFolderPath}/${task.file.name}`;
                        await vault.rename(task.file, newPath);
                        movedCount++;
                    }
                }
                catch (error) {
                    console.error(`Error moving task ${task.file.path}:`, error);
                }
            }
        }
        new obsidian_1.Notice(`Organized ${movedCount} tasks by tag`);
        this.refreshView();
    }
    // Organize tasks in a specific folder by tag
    async organizeTasksInFolder(folder) {
        const files = this.collectMarkdownFiles(folder);
        let movedCount = 0;
        const vault = this.app.vault;
        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            const tag = cache?.frontmatter?.tag || 'untagged';
            // Skip if already in correct folder
            const currentFolder = file.parent?.name;
            if (currentFolder === tag)
                continue;
            const targetFolderPath = `${folder.path}/${tag}`;
            try {
                // Create target folder if it doesn't exist
                let targetFolder = vault.getAbstractFileByPath(targetFolderPath);
                if (!targetFolder) {
                    await vault.createFolder(targetFolderPath);
                    targetFolder = vault.getAbstractFileByPath(targetFolderPath);
                }
                if (targetFolder instanceof obsidian_1.TFolder) {
                    const newPath = `${targetFolderPath}/${file.name}`;
                    await vault.rename(file, newPath);
                    movedCount++;
                }
            }
            catch (error) {
                console.error(`Error moving task ${file.path}:`, error);
            }
        }
        new obsidian_1.Notice(`Organized ${movedCount} tasks in ${folder.name} by tag`);
        this.refreshView();
    }
    // Find the base task folder for a file
    findBaseTaskFolder(file) {
        let current = file.parent;
        while (current) {
            if (this.settings.taskFolders.some(tf => current.path === tf ||
                current.path.endsWith('/' + tf) ||
                current.name === tf)) {
                return current;
            }
            current = current.parent;
        }
        return null;
    }
}
exports.default = TaskBoardPlugin;
// Task Board View
class TaskBoardView extends obsidian_1.ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.tasks = [];
        this.selectedTags = new Set();
        this.tagFilterContainer = null;
        this.hiddenStatuses = new Set();
        this.plugin = plugin;
        // Initialize hidden statuses from settings
        this.hiddenStatuses = new Set(this.plugin.settings.hiddenStatuses || []);
    }
    getViewType() {
        return VIEW_TYPE_TASK_BOARD;
    }
    getDisplayText() {
        return 'Task Board';
    }
    getIcon() {
        return 'layout-board';
    }
    async onOpen() {
        this.containerEl = this.contentEl.createDiv({ cls: 'task-board-container' });
        await this.refresh();
    }
    async refresh() {
        this.tasks = await this.plugin.scanTasks();
        this.render();
    }
    render() {
        this.containerEl.empty();
        // Header with controls
        this.renderHeader();
        // Tag filter
        this.renderTagFilter();
        // Board
        this.renderBoard();
    }
    renderHeader() {
        const header = this.containerEl.createDiv({ cls: 'task-board-header' });
        // Title
        header.createEl('h2', { text: 'Task Board', cls: 'task-board-title' });
        // Controls
        const controls = header.createDiv({ cls: 'task-board-controls' });
        // Sort dropdown
        controls.createSpan({ text: 'Sort by: ', cls: 'task-board-label' });
        const sortSelect = new obsidian_1.DropdownComponent(controls);
        sortSelect.addOption('priority', 'Priority');
        sortSelect.addOption('tag', 'Tag');
        sortSelect.addOption('title', 'Title');
        sortSelect.addOption('folder', 'Folder');
        sortSelect.setValue(this.plugin.settings.sortBy);
        sortSelect.onChange((value) => {
            this.plugin.settings.sortBy = value;
            this.plugin.saveSettings();
            this.renderBoard();
        });
        // Sort direction
        const dirBtn = controls.createEl('button', {
            cls: 'task-board-sort-dir',
            text: this.plugin.settings.sortDirection === 'asc' ? '↑' : '↓'
        });
        dirBtn.addEventListener('click', () => {
            this.plugin.settings.sortDirection =
                this.plugin.settings.sortDirection === 'asc' ? 'desc' : 'asc';
            dirBtn.textContent = this.plugin.settings.sortDirection === 'asc' ? '↑' : '↓';
            this.plugin.saveSettings();
            this.renderBoard();
        });
        // Column visibility toggles
        const visibilityControls = controls.createDiv({ cls: 'task-board-visibility' });
        visibilityControls.createSpan({ text: 'Show: ', cls: 'task-board-label' });
        // Toggle for Done column
        const doneLabel = visibilityControls.createEl('label', { cls: 'visibility-toggle' });
        const doneCheckbox = doneLabel.createEl('input', {
            type: 'checkbox',
            cls: 'visibility-checkbox'
        });
        doneCheckbox.checked = !this.hiddenStatuses.has('done');
        doneLabel.createSpan({ text: 'Done', cls: 'visibility-text' });
        doneCheckbox.addEventListener('change', () => {
            if (doneCheckbox.checked) {
                this.hiddenStatuses.delete('done');
            }
            else {
                this.hiddenStatuses.add('done');
            }
            this.plugin.settings.hiddenStatuses = Array.from(this.hiddenStatuses);
            this.plugin.saveSettings();
            this.renderBoard();
        });
        // Toggle for Archive column
        const archiveLabel = visibilityControls.createEl('label', { cls: 'visibility-toggle' });
        const archiveCheckbox = archiveLabel.createEl('input', {
            type: 'checkbox',
            cls: 'visibility-checkbox'
        });
        archiveCheckbox.checked = !this.hiddenStatuses.has('archive');
        archiveLabel.createSpan({ text: 'Archive', cls: 'visibility-text' });
        archiveCheckbox.addEventListener('change', () => {
            if (archiveCheckbox.checked) {
                this.hiddenStatuses.delete('archive');
            }
            else {
                this.hiddenStatuses.add('archive');
            }
            this.plugin.settings.hiddenStatuses = Array.from(this.hiddenStatuses);
            this.plugin.saveSettings();
            this.renderBoard();
        });
        // Organize by tag button
        const organizeBtn = controls.createEl('button', {
            cls: 'task-board-organize',
            text: '📁 Organize'
        });
        organizeBtn.title = 'Organize tasks by tag';
        organizeBtn.addEventListener('click', () => {
            this.plugin.organizeTasksByTag();
        });
        // Refresh button
        const refreshBtn = controls.createEl('button', {
            cls: 'task-board-refresh',
            text: '🔄'
        });
        refreshBtn.addEventListener('click', () => this.refresh());
        // Clear filters button (hidden by default)
        const clearBtn = controls.createEl('button', {
            cls: 'task-board-clear-filters',
            text: '✕ Clear'
        });
        clearBtn.style.display = this.selectedTags.size > 0 ? 'inline-block' : 'none';
        clearBtn.addEventListener('click', () => {
            this.selectedTags.clear();
            this.renderTagFilter();
            this.renderBoard();
        });
    }
    // Get all unique tags from tasks
    getAllTags() {
        const tags = new Set();
        for (const task of this.tasks) {
            if (task.tag) {
                tags.add(task.tag);
            }
        }
        return Array.from(tags).sort();
    }
    // Render tag filter checkboxes
    renderTagFilter() {
        // Remove existing filter if any
        if (this.tagFilterContainer) {
            this.tagFilterContainer.remove();
        }
        const tags = this.getAllTags();
        if (tags.length === 0)
            return;
        this.tagFilterContainer = this.containerEl.createDiv({ cls: 'task-tag-filter' });
        const filterHeader = this.tagFilterContainer.createDiv({ cls: 'tag-filter-header' });
        filterHeader.createSpan({ text: 'Filter by tag:', cls: 'tag-filter-label' });
        // Select all / Deselect all buttons
        const btnGroup = filterHeader.createDiv({ cls: 'tag-filter-buttons' });
        const selectAllBtn = btnGroup.createEl('button', {
            text: 'All',
            cls: 'tag-filter-btn'
        });
        selectAllBtn.addEventListener('click', () => {
            tags.forEach(tag => this.selectedTags.add(tag));
            this.renderTagFilter();
            this.renderBoard();
        });
        const deselectAllBtn = btnGroup.createEl('button', {
            text: 'None',
            cls: 'tag-filter-btn'
        });
        deselectAllBtn.addEventListener('click', () => {
            this.selectedTags.clear();
            this.renderTagFilter();
            this.renderBoard();
        });
        // Checkbox container
        const checkboxContainer = this.tagFilterContainer.createDiv({ cls: 'tag-checkbox-container' });
        for (const tag of tags) {
            const label = checkboxContainer.createEl('label', { cls: 'tag-checkbox-label' });
            const checkbox = label.createEl('input', {
                type: 'checkbox',
                cls: 'tag-checkbox'
            });
            checkbox.checked = this.selectedTags.has(tag);
            label.createSpan({ text: tag, cls: 'tag-checkbox-text' });
            // Count tasks with this tag
            const count = this.tasks.filter(t => t.tag === tag).length;
            label.createSpan({ text: `(${count})`, cls: 'tag-checkbox-count' });
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    this.selectedTags.add(tag);
                }
                else {
                    this.selectedTags.delete(tag);
                }
                this.renderBoard();
                // Update clear button visibility
                const clearBtn = this.containerEl.querySelector('.task-board-clear-filters');
                if (clearBtn) {
                    clearBtn.style.display = this.selectedTags.size > 0 ? 'inline-block' : 'none';
                }
            });
        }
    }
    renderBoard() {
        // Remove existing board if any
        const existingBoard = this.containerEl.querySelector('.task-board');
        if (existingBoard)
            existingBoard.remove();
        const board = this.containerEl.createDiv({ cls: 'task-board' });
        // Filter tasks by selected tags
        let filteredTasks = this.tasks;
        if (this.selectedTags.size > 0) {
            filteredTasks = this.tasks.filter(task => this.selectedTags.has(task.tag));
        }
        // Group tasks by status
        const tasksByStatus = new Map();
        // Initialize with configured status order
        for (const status of this.plugin.settings.statusOrder) {
            tasksByStatus.set(status, []);
        }
        // Group tasks
        for (const task of filteredTasks) {
            const status = task.status || this.plugin.settings.defaultStatus;
            if (!tasksByStatus.has(status)) {
                tasksByStatus.set(status, []);
            }
            tasksByStatus.get(status).push(task);
        }
        // Sort tasks within each column
        for (const [status, tasks] of tasksByStatus) {
            this.sortTasks(tasks);
        }
        // Create columns (skip hidden statuses)
        for (const status of this.plugin.settings.statusOrder) {
            if (this.hiddenStatuses.has(status))
                continue;
            const tasks = tasksByStatus.get(status) || [];
            this.renderColumn(board, status, tasks);
        }
    }
    sortTasks(tasks) {
        const sortBy = this.plugin.settings.sortBy;
        const direction = this.plugin.settings.sortDirection;
        const multiplier = direction === 'asc' ? 1 : -1;
        tasks.sort((a, b) => {
            let comparison = 0;
            switch (sortBy) {
                case 'priority':
                    const priorityMap = { high: 3, medium: 2, low: 1 };
                    comparison = priorityMap[a.priority] - priorityMap[b.priority];
                    break;
                case 'tag':
                    comparison = a.tag.localeCompare(b.tag);
                    break;
                case 'title':
                    comparison = a.title.localeCompare(b.title);
                    break;
                case 'folder':
                    comparison = a.folder.localeCompare(b.folder);
                    break;
            }
            return comparison * multiplier;
        });
    }
    renderColumn(board, status, tasks) {
        const column = board.createDiv({ cls: 'task-board-column' });
        column.setAttribute('data-status', status);
        // Column header
        const header = column.createDiv({ cls: 'task-column-header' });
        const statusLabel = this.getStatusLabel(status);
        header.createEl('h3', { text: statusLabel, cls: `task-column-title status-${status}` });
        header.createSpan({ text: `${tasks.length}`, cls: 'task-count' });
        // Tasks container
        const tasksContainer = column.createDiv({ cls: 'task-column-tasks' });
        // Render tasks
        for (const task of tasks) {
            this.renderTaskCard(tasksContainer, task);
        }
    }
    renderTaskCard(container, task) {
        const card = container.createDiv({ cls: `task-card priority-${task.priority}` });
        // Priority indicator
        const priorityDot = card.createDiv({ cls: `task-priority priority-${task.priority}` });
        priorityDot.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showPriorityMenu(task, priorityDot, e);
        });
        // Task title
        const title = card.createDiv({ cls: 'task-title' });
        title.createEl('a', {
            text: task.title,
            href: '#',
            cls: 'task-link'
        }).addEventListener('click', (e) => {
            e.preventDefault();
            this.app.workspace.openLinkText(task.file.path, '');
        });
        // Task meta
        const meta = card.createDiv({ cls: 'task-meta' });
        // Tag
        if (task.tag && task.tag !== 'untagged') {
            meta.createSpan({ text: task.tag, cls: 'task-tag' });
        }
        // Folder
        meta.createSpan({ text: task.folder, cls: 'task-folder' });
        // Status change on card click
        card.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showStatusMenu(task, e);
        });
        // Drag support
        card.draggable = true;
        card.addEventListener('dragstart', (e) => {
            e.dataTransfer?.setData('text/plain', task.id);
            card.classList.add('dragging');
        });
        card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
        });
    }
    showPriorityMenu(task, element, evt) {
        const menu = new obsidian_1.Menu();
        const priorities = ['high', 'medium', 'low'];
        for (const priority of priorities) {
            menu.addItem((item) => {
                item.setTitle(priority.charAt(0).toUpperCase() + priority.slice(1))
                    .setIcon(task.priority === priority ? 'check' : '')
                    .onClick(async () => {
                    await this.plugin.updateTaskPriority(task, priority);
                    this.refresh();
                });
            });
        }
        menu.showAtMouseEvent(evt);
    }
    showStatusMenu(task, evt) {
        const menu = new obsidian_1.Menu();
        for (const status of this.plugin.settings.statusOrder) {
            menu.addItem((item) => {
                const label = this.getStatusLabel(status);
                item.setTitle(label)
                    .setIcon(task.status === status ? 'check' : '')
                    .onClick(async () => {
                    await this.plugin.updateTaskStatus(task, status);
                    this.refresh();
                });
            });
        }
        menu.showAtMouseEvent(evt);
    }
    getStatusLabel(status) {
        const labels = {
            'todo': 'To Do',
            'in-progress': 'In Progress',
            'done': 'Done',
            'archive': 'Archive'
        };
        return labels[status] || status.charAt(0).toUpperCase() + status.slice(1);
    }
}
// Settings Tab
class TaskBoardSettingTab extends obsidian_1.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Task Board Settings' });
        // Task folders
        new obsidian_1.Setting(containerEl)
            .setName('Task folder names')
            .setDesc('Names of folders that contain tasks (comma-separated). Will search in subfolders recursively.')
            .addText(text => text
            .setPlaceholder('tasks, todo, issues')
            .setValue(this.plugin.settings.taskFolders.join(', '))
            .onChange(async (value) => {
            this.plugin.settings.taskFolders = value
                .split(',')
                .map(s => s.trim())
                .filter(s => s.length > 0);
            await this.plugin.saveSettings();
        }));
        // Status order
        new obsidian_1.Setting(containerEl)
            .setName('Status columns')
            .setDesc('Order of status columns (comma-separated)')
            .addText(text => text
            .setPlaceholder('todo, in-progress, done, archive')
            .setValue(this.plugin.settings.statusOrder.join(', '))
            .onChange(async (value) => {
            this.plugin.settings.statusOrder = value
                .split(',')
                .map(s => s.trim())
                .filter(s => s.length > 0);
            await this.plugin.saveSettings();
        }));
        // Default status
        new obsidian_1.Setting(containerEl)
            .setName('Default status')
            .setDesc('Default status for tasks without frontmatter')
            .addText(text => text
            .setPlaceholder('todo')
            .setValue(this.plugin.settings.defaultStatus)
            .onChange(async (value) => {
            this.plugin.settings.defaultStatus = value.trim() || 'todo';
            await this.plugin.saveSettings();
        }));
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1haW4udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSx1Q0FnQmtCO0FBeUJsQixNQUFNLGdCQUFnQixHQUFzQjtJQUN4QyxXQUFXLEVBQUUsQ0FBQyxPQUFPLENBQUM7SUFDdEIsV0FBVyxFQUFFLENBQUMsTUFBTSxFQUFFLGFBQWEsRUFBRSxNQUFNLEVBQUUsU0FBUyxDQUFDO0lBQ3ZELGFBQWEsRUFBRSxNQUFNO0lBQ3JCLE1BQU0sRUFBRSxVQUFVO0lBQ2xCLGFBQWEsRUFBRSxNQUFNO0lBQ3JCLGFBQWEsRUFBRSxLQUFLO0lBQ3BCLGNBQWMsRUFBRSxFQUFFO0NBQ3JCLENBQUM7QUFFRixNQUFNLG9CQUFvQixHQUFHLGlCQUFpQixDQUFDO0FBRS9DLG9CQUFvQjtBQUNwQixNQUFxQixlQUFnQixTQUFRLGlCQUFNO0lBRy9DLEtBQUssQ0FBQyxNQUFNO1FBQ1IsTUFBTSxJQUFJLENBQUMsWUFBWSxFQUFFLENBQUM7UUFFMUIsMkJBQTJCO1FBQzNCLElBQUksQ0FBQyxZQUFZLENBQ2Isb0JBQW9CLEVBQ3BCLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxJQUFJLGFBQWEsQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLENBQzFDLENBQUM7UUFFRixrQkFBa0I7UUFDbEIsSUFBSSxDQUFDLGFBQWEsQ0FBQyxjQUFjLEVBQUUsaUJBQWlCLEVBQUUsR0FBRyxFQUFFO1lBQ3ZELElBQUksQ0FBQyxZQUFZLEVBQUUsQ0FBQztRQUN4QixDQUFDLENBQUMsQ0FBQztRQUVILGdDQUFnQztRQUNoQyxJQUFJLENBQUMsVUFBVSxDQUFDO1lBQ1osRUFBRSxFQUFFLGlCQUFpQjtZQUNyQixJQUFJLEVBQUUsaUJBQWlCO1lBQ3ZCLFFBQVEsRUFBRSxHQUFHLEVBQUU7Z0JBQ1gsSUFBSSxDQUFDLFlBQVksRUFBRSxDQUFDO1lBQ3hCLENBQUM7U0FDSixDQUFDLENBQUM7UUFFSCxzQ0FBc0M7UUFDdEMs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QkFBaUI7UUFDakIsSUFBSSxrQkFBTyxDQUFDLFdBQVcsQ0FBQzthQUNuQixPQUFPLENBQUMsZ0JBQWdCLENBQUM7YUFDekIsT0FBTyxDQUFDLDhDQUE4QyxDQUFDO2FBQ3ZELE9BQU8sQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLElBQUk7YUFDaEIsY0FBYyxDQUFDLE1BQU0sQ0FBQzthQUN0QixRQUFRLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsYUFBYSxDQUFDO2FBQzVDLFFBQVEsQ0FBQyxLQUFLLEVBQUUsS0FBSyxFQUFFLEVBQUU7WUFDdEIsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsYUFBYSxHQUFHLEtBQUssQ0FBQyxJQUFJLEVBQUUsSUFBSSxNQUFNLENBQUM7WUFDNUQsTUFBTSxJQUFJLENBQUMsTUFBTSxDQUFDLFlBQVksRUFBRSxDQUFDO1FBQ3JDLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDaEIsQ0FBQztDQUNKIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHtcbiAgICBBcHAsXG4gICAgUGx1Z2luLFxuICAgIFBsdWdpblNldHRpbmdUYWIsXG4gICAgU2V0dGluZyxcbiAgICBURmlsZSxcbiAgICBURm9sZGVyLFxuICAgIEl0ZW1WaWV3LFxuICAgIFdvcmtzcGFjZUxlYWYsXG4gICAgTm90aWNlLFxuICAgIE1lbnUsXG4gICAgVGV4dENvbXBvbmVudCxcbiAgICBEcm9wZG93bkNvbXBvbmVudCxcbiAgICBCdXR0b25Db21wb25lbnQsXG4gICAgTWFya2Rvd25SZW5kZXJlcixcbiAgICBDb21wb25lbnRcbn0gZnJvbSAnb2JzaWRpYW4nO1xuXG4vLyBUYXNrIGludGVyZmFjZVxuaW50ZXJmYWNlIFRhc2sge1xuICAgIGlkOiBzdHJpbmc7XG4gICAgZmlsZTogVEZpbGU7XG4gICAgdGl0bGU6IHN0cmluZztcbiAgICBzdGF0dXM6IHN0cmluZztcbiAgICB0YWc6IHN0cmluZztcbiAgICBwcmlvcml0eTogJ2hpZ2gnIHwgJ21lZGl1bScgfCAnbG93JztcbiAgICBjb250ZW50OiBzdHJpbmc7XG4gICAgZm9sZGVyOiBzdHJpbmc7XG59XG5cbi8vIFBsdWdpbiBzZXR0aW5nc1xuaW50ZXJmYWNlIFRhc2tCb2FyZFNldHRpbmdzIHtcbiAgICB0YXNrRm9sZGVyczogc3RyaW5nW107XG4gICAgc3RhdHVzT3JkZXI6IHN0cmluZ1tdO1xuICAgIGRlZmF1bHRTdGF0dXM6IHN0cmluZztcbiAgICBzb3J0Qnk6ICdwcmlvcml0eScgfCAndGFnJyB8ICd0aXRsZScgfCAnZm9sZGVyJztcbiAgICBzb3J0RGlyZWN0aW9uOiAnYXNjJyB8ICdkZXNjJztcbiAgICBvcmdhbml6ZUJ5VGFnOiBib29sZWFuO1xuICAgIGhpZGRlblN0YXR1c2VzOiBzdHJpbmdbXTtcbn1cblxuY29uc3QgREVGQVVMVF9TRVRUSU5HUzogVGFza0JvYXJkU2V0dGluZ3MgPSB7XG4gICAgdGFza0ZvbGRlcnM6IFsndGFza3MnXSxcbiAgICBzdGF0dXNPcmRlcjogWyd0b2RvJywgJ2luLXByb2dyZXNzJywgJ2RvbmUnLCAnYXJjaGl2ZSddLFxuICAgIGRlZmF1bHRTdGF0dXM6ICd0b2RvJyxcbiAgICBzb3J0Qnk6ICdwcmlvcml0eScsXG4gICAgc29ydERpcmVjdGlvbjogJ2Rlc2MnLFxuICAgIG9yZ2FuaXplQnlUYWc6IGZhbHNlLFxuICAgIGhpZGRlblN0YXR1c2VzOiBbXVxufTtcblxuY29uc3QgVklFV19UWVBFX1RBU0tfQk9BUkQgPSAndGFzay1ib2FyZC12aWV3JztcblxuLy8gTWFpbiBQbHVnaW4gQ2xhc3NcbmV4cG9ydCBkZWZhdWx0IGNsYXNzIFRhc2tCb2FyZFBsdWdpbiBleHRlbmRzIFBsdWdpbiB7XG4gICAgc2V0dGluZ3M6IFRhc2tCb2FyZFNldHRpbmdzO1xuXG4gICAgYXN5bmMgb25sb2FkKCkge1xuICAgICAgICBhd2FpdCB0aGlzLmxvYWRTZXR0aW5ncygpO1xuXG4gICAgICAgIC8vIFJlZ2lzdGVyIHRoZSBjdXN0b20gdmlld1xuICAgICAgICB0aGlzLnJlZ2lzdGVyVmlldyhcbiAgICAgICAgICAgIFZJRVdfVFlQRV9UQVNLX0JPQVJELFxuICAgICAgICAgICAgKGxlYWYpID0+IG5ldyBUYXNrQm9hcmRWaWV3KGxlYWYsIHRoaXMpXG4gICAgICAgICk7XG5cbiAgICAgICAgLy8gQWRkIHJpYmJvbiBpY29uXG4gICAgICAgIHRoaXMuYWRkUmliYm9uSWNvbignbGF5b3V0LWJvYXJkJywgJ09wZW4gVGFzayBCb2FyZCcsICgpID0+IHtcbiAgICAgICAgICAgIHRoaXMuYWN0aXZhdGVWaWV3KCk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIEFkZCBjb21tYW5kIC0gT3BlbiBUYXNrIEJvYXJkXG4gICAgICAgIHRoaXMuYWRkQ29tbWFuZCh7XG4gICAgICAgICAgICBpZDogJ29wZW4tdGFzay1ib2FyZCcsXG4gICAgICAgICAgICBuYW1lOiAnT3BlbiBUYXNrIEJvYXJkJyxcbiAgICAgICAgICAgIGNhbGxiYWNrOiAoKSA9PiB7XG4gICAgICAgICAgICAgICAgdGhpcy5hY3RpdmF0ZVZpZXcoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gQWRkIGNvbW1hbmQgLSBPcmdhbml6ZSB0YXNrcyBieSB0YWdcbiAgICAgICAgdGhpcy5hZGRDb21tYW5kKHtcbiAgICAgICAgICAgIGlkOiAnb3JnYW5pemUtdGFza3MtYnktdGFnJyxcbiAgICAgICAgICAgIG5hbWU6ICdPcmdhbml6ZSB0YXNrcyBieSB0YWcnLFxuICAgICAgICAgICAgY2FsbGJhY2s6IGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLm9yZ2FuaXplVGFza3NCeVRhZygpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICAvLyBBZGQgY29tbWFuZCAtIE9yZ2FuaXplIHRhc2tzIGluIGN1cnJlbnQgZm9sZGVyXG4gICAgICAgIHRoaXMuYWRkQ29tbWFuZCh7XG4gICAgICAgICAgICBpZDogJ29yZ2FuaXplLXRhc2tzLWluLWN1cnJlbnQtZm9sZGVyJyxcbiAgICAgICAgICAgIG5hbWU6ICdPcmdhbml6ZSB0YXNrcyBpbiBjdXJyZW50IGZvbGRlciBieSB0YWcnLFxuICAgICAgICAgICAgY2hlY2tDYWxsYmFjazogKGNoZWNraW5nOiBib29sZWFuKSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgZmlsZSA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRBY3RpdmVGaWxlKCk7XG4gICAgICAgICAgICAgICAgaWYgKGZpbGUpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjaGVja2luZykge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZm9sZGVyID0gZmlsZS5wYXJlbnQ7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZm9sZGVyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5vcmdhbml6ZVRhc2tzSW5Gb2xkZXIoZm9sZGVyKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICAvLyBBZGQgc2V0dGluZ3MgdGFiXG4gICAgICAgIHRoaXMuYWRkU2V0dGluZ1RhYihuZXcgVGFza0JvYXJkU2V0dGluZ1RhYih0aGlzLmFwcCwgdGhpcykpO1xuXG4gICAgICAgIC8vIFJlZnJlc2ggdmlldyB3aGVuIGZpbGVzIGNoYW5nZVxuICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQoXG4gICAgICAgICAgICB0aGlzLmFwcC52YXVsdC5vbignY3JlYXRlJywgKCkgPT4gdGhpcy5yZWZyZXNoVmlldygpKVxuICAgICAgICApO1xuICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQoXG4gICAgICAgICAgICB0aGlzLmFwcC52YXVsdC5vbignZGVsZXRlJywgKCkgPT4gdGhpcy5yZWZyZXNoVmlldygpKVxuICAgICAgICApO1xuICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQoXG4gICAgICAgICAgICB0aGlzLmFwcC52YXVsdC5vbigncmVuYW1lJywgKCkgPT4gdGhpcy5yZWZyZXNoVmlldygpKVxuICAgICAgICApO1xuICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQoXG4gICAgICAgICAgICB0aGlzLmFwcC5tZXRhZGF0YUNhY2hlLm9uKCdjaGFuZ2VkJywgKCkgPT4gdGhpcy5yZWZyZXNoVmlldygpKVxuICAgICAgICApO1xuICAgIH1cblxuICAgIG9udW5sb2FkKCkge1xuICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2UuZGV0YWNoTGVhdmVzT2ZUeXBlKFZJRVdfVFlQRV9UQVNLX0JPQVJEKTtcbiAgICB9XG5cbiAgICBhc3luYyBsb2FkU2V0dGluZ3MoKSB7XG4gICAgICAgIHRoaXMuc2V0dGluZ3MgPSBPYmplY3QuYXNzaWduKHt9LCBERUZBVUxUX1NFVFRJTkdTLCBhd2FpdCB0aGlzLmxvYWREYXRhKCkpO1xuICAgIH1cblxuICAgIGFzeW5jIHNhdmVTZXR0aW5ncygpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5zYXZlRGF0YSh0aGlzLnNldHRpbmdzKTtcbiAgICAgICAgdGhpcy5yZWZyZXNoVmlldygpO1xuICAgIH1cblxuICAgIGFzeW5jIGFjdGl2YXRlVmlldygpIHtcbiAgICAgICAgY29uc3QgeyB3b3Jrc3BhY2UgfSA9IHRoaXMuYXBwO1xuXG4gICAgICAgIGxldCBsZWFmOiBXb3Jrc3BhY2VMZWFmIHwgbnVsbCA9IG51bGw7XG4gICAgICAgIGNvbnN0IGxlYXZlcyA9IHdvcmtzcGFjZS5nZXRMZWF2ZXNPZlR5cGUoVklFV19UWVBFX1RBU0tfQk9BUkQpO1xuXG4gICAgICAgIGlmIChsZWF2ZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgbGVhZiA9IGxlYXZlc1swXTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vIENyZWF0ZSBpbiBtYWluIHZpZXcgYXJlYSBpbnN0ZWFkIG9mIHNpZGViYXJcbiAgICAgICAgICAgIGxlYWYgPSB3b3Jrc3BhY2UuZ2V0TGVhZigndGFiJyk7XG4gICAgICAgICAgICBhd2FpdCBsZWFmLnNldFZpZXdTdGF0ZSh7IHR5cGU6IFZJRVdfVFlQRV9UQVNLX0JPQVJELCBhY3RpdmU6IHRydWUgfSk7XG4gICAgICAgIH1cblxuICAgICAgICB3b3Jrc3BhY2UucmV2ZWFsTGVhZihsZWFmKTtcbiAgICB9XG5cbiAgICByZWZyZXNoVmlldygpIHtcbiAgICAgICAgY29uc3QgbGVhdmVzID0gdGhpcy5hcHAud29ya3NwYWNlLmdldExlYXZlc09mVHlwZShWSUVXX1RZUEVfVEFTS19CT0FSRCk7XG4gICAgICAgIGZvciAoY29uc3QgbGVhZiBvZiBsZWF2ZXMpIHtcbiAgICAgICAgICAgIGNvbnN0IHZpZXcgPSBsZWFmLnZpZXcgYXMgVGFza0JvYXJkVmlldztcbiAgICAgICAgICAgIHZpZXcucmVmcmVzaCgpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gUmVjdXJzaXZlbHkgY29sbGVjdCBhbGwgbWFya2Rvd24gZmlsZXMgZnJvbSBhIGZvbGRlciBhbmQgaXRzIHN1YmZvbGRlcnNcbiAgICBwcml2YXRlIGNvbGxlY3RNYXJrZG93bkZpbGVzKGZvbGRlcjogVEZvbGRlcik6IFRGaWxlW10ge1xuICAgICAgICBjb25zdCBmaWxlczogVEZpbGVbXSA9IFtdO1xuICAgICAgICBcbiAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBmb2xkZXIuY2hpbGRyZW4pIHtcbiAgICAgICAgICAgIGlmIChjaGlsZCBpbnN0YW5jZW9mIFRGaWxlICYmIGNoaWxkLmV4dGVuc2lvbiA9PT0gJ21kJykge1xuICAgICAgICAgICAgICAgIGZpbGVzLnB1c2goY2hpbGQpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChjaGlsZCBpbnN0YW5jZW9mIFRGb2xkZXIpIHtcbiAgICAgICAgICAgICAgICAvLyBSZWN1cnNpdmVseSBnZXQgZmlsZXMgZnJvbSBzdWJmb2xkZXJzXG4gICAgICAgICAgICAgICAgZmlsZXMucHVzaCguLi50aGlzLmNvbGxlY3RNYXJrZG93bkZpbGVzKGNoaWxkKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHJldHVybiBmaWxlcztcbiAgICB9XG5cbiAgICAvLyBTY2FuIGFsbCB0YXNrIGZvbGRlcnMgYW5kIHJldHVybiB0YXNrcyAoaW5jbHVkaW5nIHN1YmZvbGRlcnMpXG4gICAgYXN5bmMgc2NhblRhc2tzKCk6IFByb21pc2U8VGFza1tdPiB7XG4gICAgICAgIGNvbnN0IHRhc2tzOiBUYXNrW10gPSBbXTtcbiAgICAgICAgY29uc3QgdmF1bHQgPSB0aGlzLmFwcC52YXVsdDtcblxuICAgICAgICAvLyBHZXQgYWxsIGZvbGRlcnMgaW4gdmF1bHRcbiAgICAgICAgY29uc3QgYWxsRm9sZGVycyA9IHZhdWx0LmdldEFsbExvYWRlZEZpbGVzKClcbiAgICAgICAgICAgIC5maWx0ZXIoZiA9PiBmIGluc3RhbmNlb2YgVEZvbGRlcikgYXMgVEZvbGRlcltdO1xuXG4gICAgICAgIC8vIEZpbmQgdGFzayBmb2xkZXJzIChleGFjdCBtYXRjaGVzIG9yIGZvbGRlcnMgZW5kaW5nIHdpdGggL3Rhc2tzLCBldGMuKVxuICAgICAgICBjb25zdCB0YXNrRm9sZGVyczogVEZvbGRlcltdID0gW107XG4gICAgICAgIGZvciAoY29uc3QgZm9sZGVyIG9mIGFsbEZvbGRlcnMpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLnNldHRpbmdzLnRhc2tGb2xkZXJzLnNvbWUodGYgPT4gXG4gICAgICAgICAgICAgICAgZm9sZGVyLnBhdGggPT09IHRmIHx8IFxuICAgICAgICAgICAgICAgIGZvbGRlci5wYXRoLmVuZHNXaXRoKCcvJyArIHRmKSB8fFxuICAgICAgICAgICAgICAgIGZvbGRlci5uYW1lID09PSB0ZlxuICAgICAgICAgICAgKSkge1xuICAgICAgICAgICAgICAgIHRhc2tGb2xkZXJzLnB1c2goZm9sZGVyKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFNjYW4gZWFjaCB0YXNrIGZvbGRlciByZWN1cnNpdmVseVxuICAgICAgICBmb3IgKGNvbnN0IGZvbGRlciBvZiB0YXNrRm9sZGVycykge1xuICAgICAgICAgICAgLy8gUmVjdXJzaXZlbHkgY29sbGVjdCBhbGwgbWFya2Rvd24gZmlsZXMgaW5jbHVkaW5nIHN1YmZvbGRlcnNcbiAgICAgICAgICAgIGNvbnN0IGZpbGVzID0gdGhpcy5jb2xsZWN0TWFya2Rvd25GaWxlcyhmb2xkZXIpO1xuXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGZpbGUgb2YgZmlsZXMpIHtcbiAgICAgICAgICAgICAgICBjb25zdCB0YXNrID0gYXdhaXQgdGhpcy5wYXJzZVRhc2tGaWxlKGZpbGUsIGZvbGRlcik7XG4gICAgICAgICAgICAgICAgaWYgKHRhc2spIHtcbiAgICAgICAgICAgICAgICAgICAgdGFza3MucHVzaCh0YXNrKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGFza3M7XG4gICAgfVxuXG4gICAgLy8gUGFyc2UgYSB0YXNrIGZpbGUgYW5kIGV4dHJhY3QgbWV0YWRhdGFcbiAgICBhc3luYyBwYXJzZVRhc2tGaWxlKGZpbGU6IFRGaWxlLCBmb2xkZXI6IFRGb2xkZXIpOiBQcm9taXNlPFRhc2sgfCBudWxsPiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBjYWNoZSA9IHRoaXMuYXBwLm1ldGFkYXRhQ2FjaGUuZ2V0RmlsZUNhY2hlKGZpbGUpO1xuICAgICAgICAgICAgY29uc3QgZnJvbnRtYXR0ZXIgPSBjYWNoZT8uZnJvbnRtYXR0ZXI7XG5cbiAgICAgICAgICAgIC8vIFJlYWQgZmlsZSBjb250ZW50IGZvciB0aXRsZSAoZmlyc3QgbGluZSBvciBoMSlcbiAgICAgICAgICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCB0aGlzLmFwcC52YXVsdC5yZWFkKGZpbGUpO1xuICAgICAgICAgICAgbGV0IHRpdGxlID0gZmlsZS5iYXNlbmFtZTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy8gVHJ5IHRvIGZpbmQgYSBiZXR0ZXIgdGl0bGUgZnJvbSBjb250ZW50XG4gICAgICAgICAgICBjb25zdCBsaW5lcyA9IGNvbnRlbnQuc3BsaXQoJ1xcbicpO1xuICAgICAgICAgICAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgdHJpbW1lZCA9IGxpbmUudHJpbSgpO1xuICAgICAgICAgICAgICAgIGlmICh0cmltbWVkICYmICF0cmltbWVkLnN0YXJ0c1dpdGgoJy0tLScpKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICh0cmltbWVkLnN0YXJ0c1dpdGgoJyMgJykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRpdGxlID0gdHJpbW1lZC5zdWJzdHJpbmcoMikudHJpbSgpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gR2V0IHBhcmVudCBmb2xkZXIgbmFtZSBhcyBjYXRlZ29yeVxuICAgICAgICAgICAgY29uc3QgZm9sZGVyUGFydHMgPSBmb2xkZXIucGF0aC5zcGxpdCgnLycpO1xuICAgICAgICAgICAgY29uc3QgcGFyZW50Rm9sZGVyID0gZm9sZGVyUGFydHMubGVuZ3RoID4gMSA/IGZvbGRlclBhcnRzW2ZvbGRlclBhcnRzLmxlbmd0aCAtIDJdIDogJ1Jvb3QnO1xuXG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIGlkOiBmaWxlLnBhdGgsXG4gICAgICAgICAgICAgICAgZmlsZTogZmlsZSxcbiAgICAgICAgICAgICAgICB0aXRsZTogdGl0bGUsXG4gICAgICAgICAgICAgICAgc3RhdHVzOiBmcm9udG1hdHRlcj8uc3RhdHVzIHx8IHRoaXMuc2V0dGluZ3MuZGVmYXVsdFN0YXR1cyxcbiAgICAgICAgICAgICAgICB0YWc6IGZyb250bWF0dGVyPy50YWcgfHwgJ3VudGFnZ2VkJyxcbiAgICAgICAgICAgICAgICBwcmlvcml0eTogKGZyb250bWF0dGVyPy5wcmlvcml0eSB8fCAnbWVkaXVtJykgYXMgJ2hpZ2gnIHwgJ21lZGl1bScgfCAnbG93JyxcbiAgICAgICAgICAgICAgICBjb250ZW50OiBjb250ZW50LFxuICAgICAgICAgICAgICAgIGZvbGRlcjogcGFyZW50Rm9sZGVyXG4gICAgICAgICAgICB9O1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgY29uc29sZS5lcnJvcignRXJyb3IgcGFyc2luZyB0YXNrIGZpbGU6JywgZmlsZS5wYXRoLCBlcnJvcik7XG4gICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIFVwZGF0ZSB0YXNrIHN0YXR1c1xuICAgIGFzeW5jIHVwZGF0ZVRhc2tTdGF0dXModGFzazogVGFzaywgbmV3U3RhdHVzOiBzdHJpbmcpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGNhY2hlID0gdGhpcy5hcHAubWV0YWRhdGFDYWNoZS5nZXRGaWxlQ2FjaGUodGFzay5maWxlKTtcbiAgICAgICAgICAgIGNvbnN0IGZyb250bWF0dGVyID0gY2FjaGU/LmZyb250bWF0dGVyO1xuXG4gICAgICAgICAgICBpZiAoZnJvbnRtYXR0ZXIpIHtcbiAgICAgICAgICAgICAgICAvLyBVcGRhdGUgZnJvbnRtYXR0ZXJcbiAgICAgICAgICAgICAgICBjb25zdCBjb250ZW50ID0gYXdhaXQgdGhpcy5hcHAudmF1bHQucmVhZCh0YXNrLmZpbGUpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGZyb250bWF0dGVyUmVnZXggPSAvXi0tLVxcbihbXFxzXFxTXSo/KVxcbi0tLS87XG4gICAgICAgICAgICAgICAgY29uc3QgbWF0Y2ggPSBjb250ZW50Lm1hdGNoKGZyb250bWF0dGVyUmVnZXgpO1xuXG4gICAgICAgICAgICAgICAgaWYgKG1hdGNoKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBuZXdGcm9udG1hdHRlciA9IG1hdGNoWzFdO1xuICAgICAgICAgICAgICAgICAgICAvLyBSZXBsYWNlIHN0YXR1cyBsaW5lXG4gICAgICAgICAgICAgICAgICAgIG5ld0Zyb250bWF0dGVyID0gbmV3RnJvbnRtYXR0ZXIucmVwbGFjZShcbiAgICAgICAgICAgICAgICAgICAgICAgIC9zdGF0dXM6XFxzKlxcdysvLFxuICAgICAgICAgICAgICAgICAgICAgICAgYHN0YXR1czogJHtuZXdTdGF0dXN9YFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICAvLyBJZiBzdGF0dXMgZG9lc24ndCBleGlzdCwgYWRkIGl0XG4gICAgICAgICAgICAgICAgICAgIGlmICghbmV3RnJvbnRtYXR0ZXIuaW5jbHVkZXMoJ3N0YXR1czonKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbmV3RnJvbnRtYXR0ZXIgPSBgc3RhdHVzOiAke25ld1N0YXR1c31cXG4ke25ld0Zyb250bWF0dGVyfWA7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBjb25zdCBuZXdDb250ZW50ID0gY29udGVudC5yZXBsYWNlKGZyb250bWF0dGVyUmVnZXgsIGAtLS1cXG4ke25ld0Zyb250bWF0dGVyfVxcbi0tLWApO1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5tb2RpZnkodGFzay5maWxlLCBuZXdDb250ZW50KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIEFkZCBmcm9udG1hdHRlciBpZiBpdCBkb2Vzbid0IGV4aXN0XG4gICAgICAgICAgICAgICAgY29uc3QgbmV3RnJvbnRtYXR0ZXIgPSBgLS0tXFxuc3RhdHVzOiAke25ld1N0YXR1c31cXG50YWc6ICR7dGFzay50YWd9XFxucHJpb3JpdHk6ICR7dGFzay5wcmlvcml0eX1cXG4tLS1cXG5cXG5gO1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYXBwLnZhdWx0Lm1vZGlmeSh0YXNrLmZpbGUsIG5ld0Zyb250bWF0dGVyICsgdGFzay5jb250ZW50KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGFzay5zdGF0dXMgPSBuZXdTdGF0dXM7XG4gICAgICAgICAgICBuZXcgTm90aWNlKGBUYXNrIG1vdmVkIHRvICR7bmV3U3RhdHVzfWApO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgY29uc29sZS5lcnJvcignRXJyb3IgdXBkYXRpbmcgdGFzayBzdGF0dXM6JywgZXJyb3IpO1xuICAgICAgICAgICAgbmV3IE5vdGljZSgnRmFpbGVkIHRvIHVwZGF0ZSB0YXNrIHN0YXR1cycpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gVXBkYXRlIHRhc2sgcHJpb3JpdHlcbiAgICBhc3luYyB1cGRhdGVUYXNrUHJpb3JpdHkodGFzazogVGFzaywgbmV3UHJpb3JpdHk6IHN0cmluZykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgY29udGVudCA9IGF3YWl0IHRoaXMuYXBwLnZhdWx0LnJlYWQodGFzay5maWxlKTtcbiAgICAgICAgICAgIGNvbnN0IGZyb250bWF0dGVyUmVnZXggPSAvXi0tLVxcbihbXFxzXFxTXSo/KVxcbi0tLS87XG4gICAgICAgICAgICBjb25zdCBtYXRjaCA9IGNvbnRlbnQubWF0Y2goZnJvbnRtYXR0ZXJSZWdleCk7XG5cbiAgICAgICAgICAgIGlmIChtYXRjaCkge1xuICAgICAgICAgICAgICAgIGxldCBuZXdGcm9udG1hdHRlciA9IG1hdGNoWzFdO1xuICAgICAgICAgICAgICAgIG5ld0Zyb250bWF0dGVyID0gbmV3RnJvbnRtYXR0ZXIucmVwbGFjZShcbiAgICAgICAgICAgICAgICAgICAgL3ByaW9yaXR5OlxccypcXHcrLyxcbiAgICAgICAgICAgICAgICAgICAgYHByaW9yaXR5OiAke25ld1ByaW9yaXR5fWBcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIGlmICghbmV3RnJvbnRtYXR0ZXIuaW5jbHVkZXMoJ3ByaW9yaXR5OicpKSB7XG4gICAgICAgICAgICAgICAgICAgIG5ld0Zyb250bWF0dGVyID0gbmV3RnJvbnRtYXR0ZXIucmVwbGFjZShcbiAgICAgICAgICAgICAgICAgICAgICAgIC8oc3RhdHVzOlteXFxuXSopLyxcbiAgICAgICAgICAgICAgICAgICAgICAgIGAkMVxcbnByaW9yaXR5OiAke25ld1ByaW9yaXR5fWBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdCBuZXdDb250ZW50ID0gY29udGVudC5yZXBsYWNlKGZyb250bWF0dGVyUmVnZXgsIGAtLS1cXG4ke25ld0Zyb250bWF0dGVyfVxcbi0tLWApO1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYXBwLnZhdWx0Lm1vZGlmeSh0YXNrLmZpbGUsIG5ld0NvbnRlbnQpO1xuICAgICAgICAgICAgICAgIHRhc2sucHJpb3JpdHkgPSBuZXdQcmlvcml0eSBhcyAnaGlnaCcgfCAnbWVkaXVtJyB8ICdsb3cnO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgY29uc29sZS5lcnJvcignRXJyb3IgdXBkYXRpbmcgdGFzayBwcmlvcml0eTonLCBlcnJvcik7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBPcmdhbml6ZSBhbGwgdGFza3MgYnkgdGFnIC0gbW92ZXMgZmlsZXMgaW50byBzdWJmb2xkZXJzIG5hbWVkIGFmdGVyIHRoZWlyIHRhZ3NcbiAgICBhc3luYyBvcmdhbml6ZVRhc2tzQnlUYWcoKSB7XG4gICAgICAgIGNvbnN0IHRhc2tzID0gYXdhaXQgdGhpcy5zY2FuVGFza3MoKTtcbiAgICAgICAgY29uc3QgdGFza3NCeVRhZyA9IG5ldyBNYXA8c3RyaW5nLCBUYXNrW10+KCk7XG5cbiAgICAgICAgLy8gR3JvdXAgdGFza3MgYnkgdGFnXG4gICAgICAgIGZvciAoY29uc3QgdGFzayBvZiB0YXNrcykge1xuICAgICAgICAgICAgY29uc3QgdGFnID0gdGFzay50YWcgfHwgJ3VudGFnZ2VkJztcbiAgICAgICAgICAgIGlmICghdGFza3NCeVRhZy5oYXModGFnKSkge1xuICAgICAgICAgICAgICAgIHRhc2tzQnlUYWcuc2V0KHRhZywgW10pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGFza3NCeVRhZy5nZXQodGFnKSEucHVzaCh0YXNrKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBtb3ZlZENvdW50ID0gMDtcbiAgICAgICAgY29uc3QgdmF1bHQgPSB0aGlzLmFwcC52YXVsdDtcblxuICAgICAgICAvLyBQcm9jZXNzIGVhY2ggdGFnIGdyb3VwXG4gICAgICAgIGZvciAoY29uc3QgW3RhZywgdGFnVGFza3NdIG9mIHRhc2tzQnlUYWcpIHtcbiAgICAgICAgICAgIGZvciAoY29uc3QgdGFzayBvZiB0YWdUYXNrcykge1xuICAgICAgICAgICAgICAgIC8vIFNraXAgaWYgYWxyZWFkeSBpbiBjb3JyZWN0IGZvbGRlclxuICAgICAgICAgICAgICAgIGNvbnN0IGN1cnJlbnRGb2xkZXIgPSB0YXNrLmZpbGUucGFyZW50Py5uYW1lO1xuICAgICAgICAgICAgICAgIGlmIChjdXJyZW50Rm9sZGVyID09PSB0YWcpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgICAgICAgLy8gRGV0ZXJtaW5lIGRlc3RpbmF0aW9uIGZvbGRlclxuICAgICAgICAgICAgICAgIGNvbnN0IGJhc2VGb2xkZXIgPSB0aGlzLmZpbmRCYXNlVGFza0ZvbGRlcih0YXNrLmZpbGUpO1xuICAgICAgICAgICAgICAgIGlmICghYmFzZUZvbGRlcikgY29udGludWU7XG5cbiAgICAgICAgICAgICAgICBjb25zdCB0YXJnZXRGb2xkZXJQYXRoID0gYCR7YmFzZUZvbGRlci5wYXRofS8ke3RhZ31gO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIENyZWF0ZSB0YXJnZXQgZm9sZGVyIGlmIGl0IGRvZXNuJ3QgZXhpc3RcbiAgICAgICAgICAgICAgICAgICAgbGV0IHRhcmdldEZvbGRlciA9IHZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aCh0YXJnZXRGb2xkZXJQYXRoKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCF0YXJnZXRGb2xkZXIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IHZhdWx0LmNyZWF0ZUZvbGRlcih0YXJnZXRGb2xkZXJQYXRoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhcmdldEZvbGRlciA9IHZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aCh0YXJnZXRGb2xkZXJQYXRoKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICh0YXJnZXRGb2xkZXIgaW5zdGFuY2VvZiBURm9sZGVyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBuZXdQYXRoID0gYCR7dGFyZ2V0Rm9sZGVyUGF0aH0vJHt0YXNrLmZpbGUubmFtZX1gO1xuICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgdmF1bHQucmVuYW1lKHRhc2suZmlsZSwgbmV3UGF0aCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBtb3ZlZENvdW50Kys7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmVycm9yKGBFcnJvciBtb3ZpbmcgdGFzayAke3Rhc2suZmlsZS5wYXRofTpgLCBlcnJvcik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbmV3IE5vdGljZShgT3JnYW5pemVkICR7bW92ZWRDb3VudH0gdGFza3MgYnkgdGFnYCk7XG4gICAgICAgIHRoaXMucmVmcmVzaFZpZXcoKTtcbiAgICB9XG5cbiAgICAvLyBPcmdhbml6ZSB0YXNrcyBpbiBhIHNwZWNpZmljIGZvbGRlciBieSB0YWdcbiAgICBhc3luYyBvcmdhbml6ZVRhc2tzSW5Gb2xkZXIoZm9sZGVyOiBURm9sZGVyKSB7XG4gICAgICAgIGNvbnN0IGZpbGVzID0gdGhpcy5jb2xsZWN0TWFya2Rvd25GaWxlcyhmb2xkZXIpO1xuICAgICAgICBsZXQgbW92ZWRDb3VudCA9IDA7XG4gICAgICAgIGNvbnN0IHZhdWx0ID0gdGhpcy5hcHAudmF1bHQ7XG5cbiAgICAgICAgZm9yIChjb25zdCBmaWxlIG9mIGZpbGVzKSB7XG4gICAgICAgICAgICBjb25zdCBjYWNoZSA9IHRoaXMuYXBwLm1ldGFkYXRhQ2FjaGUuZ2V0RmlsZUNhY2hlKGZpbGUpO1xuICAgICAgICAgICAgY29uc3QgdGFnID0gY2FjaGU/LmZyb250bWF0dGVyPy50YWcgfHwgJ3VudGFnZ2VkJztcblxuICAgICAgICAgICAgLy8gU2tpcCBpZiBhbHJlYWR5IGluIGNvcnJlY3QgZm9sZGVyXG4gICAgICAgICAgICBjb25zdCBjdXJyZW50Rm9sZGVyID0gZmlsZS5wYXJlbnQ/Lm5hbWU7XG4gICAgICAgICAgICBpZiAoY3VycmVudEZvbGRlciA9PT0gdGFnKSBjb250aW51ZTtcblxuICAgICAgICAgICAgY29uc3QgdGFyZ2V0Rm9sZGVyUGF0aCA9IGAke2ZvbGRlci5wYXRofS8ke3RhZ31gO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIC8vIENyZWF0ZSB0YXJnZXQgZm9sZGVyIGlmIGl0IGRvZXNuJ3QgZXhpc3RcbiAgICAgICAgICAgICAgICBsZXQgdGFyZ2V0Rm9sZGVyID0gdmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHRhcmdldEZvbGRlclBhdGgpO1xuICAgICAgICAgICAgICAgIGlmICghdGFyZ2V0Rm9sZGVyKSB7XG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHZhdWx0LmNyZWF0ZUZvbGRlcih0YXJnZXRGb2xkZXJQYXRoKTtcbiAgICAgICAgICAgICAgICAgICAgdGFyZ2V0Rm9sZGVyID0gdmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHRhcmdldEZvbGRlclBhdGgpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICh0YXJnZXRGb2xkZXIgaW5zdGFuY2VvZiBURm9sZGVyKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG5ld1BhdGggPSBgJHt0YXJnZXRGb2xkZXJQYXRofS8ke2ZpbGUubmFtZX1gO1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCB2YXVsdC5yZW5hbWUoZmlsZSwgbmV3UGF0aCk7XG4gICAgICAgICAgICAgICAgICAgIG1vdmVkQ291bnQrKztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYEVycm9yIG1vdmluZyB0YXNrICR7ZmlsZS5wYXRofTpgLCBlcnJvcik7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBuZXcgTm90aWNlKGBPcmdhbml6ZWQgJHttb3ZlZENvdW50fSB0YXNrcyBpbiAke2ZvbGRlci5uYW1lfSBieSB0YWdgKTtcbiAgICAgICAgdGhpcy5yZWZyZXNoVmlldygpO1xuICAgIH1cblxuICAgIC8vIEZpbmQgdGhlIGJhc2UgdGFzayBmb2xkZXIgZm9yIGEgZmlsZVxuICAgIHByaXZhdGUgZmluZEJhc2VUYXNrRm9sZGVyKGZpbGU6IFRGaWxlKTogVEZvbGRlciB8IG51bGwge1xuICAgICAgICBsZXQgY3VycmVudCA9IGZpbGUucGFyZW50O1xuICAgICAgICBcbiAgICAgICAgd2hpbGUgKGN1cnJlbnQpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLnNldHRpbmdzLnRhc2tGb2xkZXJzLnNvbWUodGYgPT4gXG4gICAgICAgICAgICAgICAgY3VycmVudCEucGF0aCA9PT0gdGYgfHwgXG4gICAgICAgICAgICAgICAgY3VycmVudCEucGF0aC5lbmRzV2l0aCgnLycgKyB0ZikgfHxcbiAgICAgICAgICAgICAgICBjdXJyZW50IS5uYW1lID09PSB0ZlxuICAgICAgICAgICAgKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBjdXJyZW50O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY3VycmVudCA9IGN1cnJlbnQucGFyZW50O1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG59XG5cbi8vIFRhc2sgQm9hcmQgVmlld1xuY2xhc3MgVGFza0JvYXJkVmlldyBleHRlbmRzIEl0ZW1WaWV3IHtcbiAgICBwbHVnaW46IFRhc2tCb2FyZFBsdWdpbjtcbiAgICB0YXNrczogVGFza1tdID0gW107XG4gICAgY29udGFpbmVyRWw6IEhUTUxFbGVtZW50O1xuICAgIHNvcnRTZWxlY3Q6IERyb3Bkb3duQ29tcG9uZW50O1xuICAgIHNlbGVjdGVkVGFnczogU2V0PHN0cmluZz4gPSBuZXcgU2V0KCk7XG4gICAgdGFnRmlsdGVyQ29udGFpbmVyOiBIVE1MRWxlbWVudCB8IG51bGwgPSBudWxsO1xuICAgIGhpZGRlblN0YXR1c2VzOiBTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoKTtcblxuICAgIGNvbnN0cnVjdG9yKGxlYWY6IFdvcmtzcGFjZUxlYWYsIHBsdWdpbjogVGFza0JvYXJkUGx1Z2luKSB7XG4gICAgICAgIHN1cGVyKGxlYWYpO1xuICAgICAgICB0aGlzLnBsdWdpbiA9IHBsdWdpbjtcbiAgICAgICAgLy8gSW5pdGlhbGl6ZSBoaWRkZW4gc3RhdHVzZXMgZnJvbSBzZXR0aW5nc1xuICAgICAgICB0aGlzLmhpZGRlblN0YXR1c2VzID0gbmV3IFNldCh0aGlzLnBsdWdpbi5zZXR0aW5ncy5oaWRkZW5TdGF0dXNlcyB8fCBbXSk7XG4gICAgfVxuXG4gICAgZ2V0Vmlld1R5cGUoKTogc3RyaW5nIHtcbiAgICAgICAgcmV0dXJuIFZJRVdfVFlQRV9UQVNLX0JPQVJEO1xuICAgIH1cblxuICAgIGdldERpc3BsYXlUZXh0KCk6IHN0cmluZyB7XG4gICAgICAgIHJldHVybiAnVGFzayBCb2FyZCc7XG4gICAgfVxuXG4gICAgZ2V0SWNvbigpOiBzdHJpbmcge1xuICAgICAgICByZXR1cm4gJ2xheW91dC1ib2FyZCc7XG4gICAgfVxuXG4gICAgYXN5bmMgb25PcGVuKCkge1xuICAgICAgICB0aGlzLmNvbnRhaW5lckVsID0gdGhpcy5jb250ZW50RWwuY3JlYXRlRGl2KHsgY2xzOiAndGFzay1ib2FyZC1jb250YWluZXInIH0pO1xuICAgICAgICBhd2FpdCB0aGlzLnJlZnJlc2goKTtcbiAgICB9XG5cbiAgICBhc3luYyByZWZyZXNoKCkge1xuICAgICAgICB0aGlzLnRhc2tzID0gYXdhaXQgdGhpcy5wbHVnaW4uc2NhblRhc2tzKCk7XG4gICAgICAgIHRoaXMucmVuZGVyKCk7XG4gICAgfVxuXG4gICAgcmVuZGVyKCkge1xuICAgICAgICB0aGlzLmNvbnRhaW5lckVsLmVtcHR5KCk7XG5cbiAgICAgICAgLy8gSGVhZGVyIHdpdGggY29udHJvbHNcbiAgICAgICAgdGhpcy5yZW5kZXJIZWFkZXIoKTtcblxuICAgICAgICAvLyBUYWcgZmlsdGVyXG4gICAgICAgIHRoaXMucmVuZGVyVGFnRmlsdGVyKCk7XG5cbiAgICAgICAgLy8gQm9hcmRcbiAgICAgICAgdGhpcy5yZW5kZXJCb2FyZCgpO1xuICAgIH1cblxuICAgIHJlbmRlckhlYWRlcigpIHtcbiAgICAgICAgY29uc3QgaGVhZGVyID0gdGhpcy5jb250YWluZXJFbC5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLWJvYXJkLWhlYWRlcicgfSk7XG5cbiAgICAgICAgLy8gVGl0bGVcbiAgICAgICAgaGVhZGVyLmNyZWF0ZUVsKCdoMicsIHsgdGV4dDogJ1Rhc2sgQm9hcmQnLCBjbHM6ICd0YXNrLWJvYXJkLXRpdGxlJyB9KTtcblxuICAgICAgICAvLyBDb250cm9sc1xuICAgICAgICBjb25zdCBjb250cm9scyA9IGhlYWRlci5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLWJvYXJkLWNvbnRyb2xzJyB9KTtcblxuICAgICAgICAvLyBTb3J0IGRyb3Bkb3duXG4gICAgICAgIGNvbnRyb2xzLmNyZWF0ZVNwYW4oeyB0ZXh0OiAnU29ydCBieTogJywgY2xzOiAndGFzay1ib2FyZC1sYWJlbCcgfSk7XG4gICAgICAgIGNvbnN0IHNvcnRTZWxlY3QgPSBuZXcgRHJvcGRvd25Db21wb25lbnQoY29udHJvbHMpO1xuICAgICAgICBzb3J0U2VsZWN0LmFkZE9wdGlvbigncHJpb3JpdHknLCAnUHJpb3JpdHknKTtcbiAgICAgICAgc29ydFNlbGVjdC5hZGRPcHRpb24oJ3RhZycsICdUYWcnKTtcbiAgICAgICAgc29ydFNlbGVjdC5hZGRPcHRpb24oJ3RpdGxlJywgJ1RpdGxlJyk7XG4gICAgICAgIHNvcnRTZWxlY3QuYWRkT3B0aW9uKCdmb2xkZXInLCAnRm9sZGVyJyk7XG4gICAgICAgIHNvcnRTZWxlY3Quc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3Muc29ydEJ5KTtcbiAgICAgICAgc29ydFNlbGVjdC5vbkNoYW5nZSgodmFsdWUpID0+IHtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLnNvcnRCeSA9IHZhbHVlIGFzIGFueTtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgdGhpcy5yZW5kZXJCb2FyZCgpO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBTb3J0IGRpcmVjdGlvblxuICAgICAgICBjb25zdCBkaXJCdG4gPSBjb250cm9scy5jcmVhdGVFbCgnYnV0dG9uJywge1xuICAgICAgICAgICAgY2xzOiAndGFzay1ib2FyZC1zb3J0LWRpcicsXG4gICAgICAgICAgICB0ZXh0OiB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zb3J0RGlyZWN0aW9uID09PSAnYXNjJyA/ICfihpEnIDogJ+KGkydcbiAgICAgICAgfSk7XG4gICAgICAgIGRpckJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLnNvcnREaXJlY3Rpb24gPSBcbiAgICAgICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zb3J0RGlyZWN0aW9uID09PSAnYXNjJyA/ICdkZXNjJyA6ICdhc2MnO1xuICAgICAgICAgICAgZGlyQnRuLnRleHRDb250ZW50ID0gdGhpcy5wbHVnaW4uc2V0dGluZ3Muc29ydERpcmVjdGlvbiA9PT0gJ2FzYycgPyAn4oaRJyA6ICfihpMnO1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgICB0aGlzLnJlbmRlckJvYXJkKCk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIENvbHVtbiB2aXNpYmlsaXR5IHRvZ2dsZXNcbiAgICAgICAgY29uc3QgdmlzaWJpbGl0eUNvbnRyb2xzID0gY29udHJvbHMuY3JlYXRlRGl2KHsgY2xzOiAndGFzay1ib2FyZC12aXNpYmlsaXR5JyB9KTtcbiAgICAgICAgdmlzaWJpbGl0eUNvbnRyb2xzLmNyZWF0ZVNwYW4oeyB0ZXh0OiAnU2hvdzogJywgY2xzOiAndGFzay1ib2FyZC1sYWJlbCcgfSk7XG5cbiAgICAgICAgLy8gVG9nZ2xlIGZvciBEb25lIGNvbHVtblxuICAgICAgICBjb25zdCBkb25lTGFiZWwgPSB2aXNpYmlsaXR5Q29udHJvbHMuY3JlYXRlRWwoJ2xhYmVsJywgeyBjbHM6ICd2aXNpYmlsaXR5LXRvZ2dsZScgfSk7XG4gICAgICAgIGNvbnN0IGRvbmVDaGVja2JveCA9IGRvbmVMYWJlbC5jcmVhdGVFbCgnaW5wdXQnLCB7XG4gICAgICAgICAgICB0eXBlOiAnY2hlY2tib3gnLFxuICAgICAgICAgICAgY2xzOiAndmlzaWJpbGl0eS1jaGVja2JveCdcbiAgICAgICAgfSk7XG4gICAgICAgIGRvbmVDaGVja2JveC5jaGVja2VkID0gIXRoaXMuaGlkZGVuU3RhdHVzZXMuaGFzKCdkb25lJyk7XG4gICAgICAgIGRvbmVMYWJlbC5jcmVhdGVTcGFuKHsgdGV4dDogJ0RvbmUnLCBjbHM6ICd2aXNpYmlsaXR5LXRleHQnIH0pO1xuICAgICAgICBkb25lQ2hlY2tib3guYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4ge1xuICAgICAgICAgICAgaWYgKGRvbmVDaGVja2JveC5jaGVja2VkKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5oaWRkZW5TdGF0dXNlcy5kZWxldGUoJ2RvbmUnKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhpcy5oaWRkZW5TdGF0dXNlcy5hZGQoJ2RvbmUnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLmhpZGRlblN0YXR1c2VzID0gQXJyYXkuZnJvbSh0aGlzLmhpZGRlblN0YXR1c2VzKTtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgdGhpcy5yZW5kZXJCb2FyZCgpO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBUb2dnbGUgZm9yIEFyY2hpdmUgY29sdW1uXG4gICAgICAgIGNvbnN0IGFyY2hpdmVMYWJlbCA9IHZpc2liaWxpdHlDb250cm9scy5jcmVhdGVFbCgnbGFiZWwnLCB7IGNsczogJ3Zpc2liaWxpdHktdG9nZ2xlJyB9KTtcbiAgICAgICAgY29uc3QgYXJjaGl2ZUNoZWNrYm94ID0gYXJjaGl2ZUxhYmVsLmNyZWF0ZUVsKCdpbnB1dCcsIHtcbiAgICAgICAgICAgIHR5cGU6ICdjaGVja2JveCcsXG4gICAgICAgICAgICBjbHM6ICd2aXNpYmlsaXR5LWNoZWNrYm94J1xuICAgICAgICB9KTtcbiAgICAgICAgYXJjaGl2ZUNoZWNrYm94LmNoZWNrZWQgPSAhdGhpcy5oaWRkZW5TdGF0dXNlcy5oYXMoJ2FyY2hpdmUnKTtcbiAgICAgICAgYXJjaGl2ZUxhYmVsLmNyZWF0ZVNwYW4oeyB0ZXh0OiAnQXJjaGl2ZScsIGNsczogJ3Zpc2liaWxpdHktdGV4dCcgfSk7XG4gICAgICAgIGFyY2hpdmVDaGVja2JveC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7XG4gICAgICAgICAgICBpZiAoYXJjaGl2ZUNoZWNrYm94LmNoZWNrZWQpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmhpZGRlblN0YXR1c2VzLmRlbGV0ZSgnYXJjaGl2ZScpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLmhpZGRlblN0YXR1c2VzLmFkZCgnYXJjaGl2ZScpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MuaGlkZGVuU3RhdHVzZXMgPSBBcnJheS5mcm9tKHRoaXMuaGlkZGVuU3RhdHVzZXMpO1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgICB0aGlzLnJlbmRlckJvYXJkKCk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIE9yZ2FuaXplIGJ5IHRhZyBidXR0b25cbiAgICAgICAgY29uc3Qgb3JnYW5pemVCdG4gPSBjb250cm9scy5jcmVhdGVFbCgnYnV0dG9uJywge1xuICAgICAgICAgICAgY2xzOiAndGFzay1ib2FyZC1vcmdhbml6ZScsXG4gICAgICAgICAgICB0ZXh0OiAn8J+TgSBPcmdhbml6ZSdcbiAgICAgICAgfSk7XG4gICAgICAgIG9yZ2FuaXplQnRuLnRpdGxlID0gJ09yZ2FuaXplIHRhc2tzIGJ5IHRhZyc7XG4gICAgICAgIG9yZ2FuaXplQnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4ub3JnYW5pemVUYXNrc0J5VGFnKCk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIFJlZnJlc2ggYnV0dG9uXG4gICAgICAgIGNvbnN0IHJlZnJlc2hCdG4gPSBjb250cm9scy5jcmVhdGVFbCgnYnV0dG9uJywge1xuICAgICAgICAgICAgY2xzOiAndGFzay1ib2FyZC1yZWZyZXNoJyxcbiAgICAgICAgICAgIHRleHQ6ICfwn5SEJ1xuICAgICAgICB9KTtcbiAgICAgICAgcmVmcmVzaEJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHRoaXMucmVmcmVzaCgpKTtcblxuICAgICAgICAvLyBDbGVhciBmaWx0ZXJzIGJ1dHRvbiAoaGlkZGVuIGJ5IGRlZmF1bHQpXG4gICAgICAgIGNvbnN0IGNsZWFyQnRuID0gY29udHJvbHMuY3JlYXRlRWwoJ2J1dHRvbicsIHtcbiAgICAgICAgICAgIGNsczogJ3Rhc2stYm9hcmQtY2xlYXItZmlsdGVycycsXG4gICAgICAgICAgICB0ZXh0OiAn4pyVIENsZWFyJ1xuICAgICAgICB9KTtcbiAgICAgICAgY2xlYXJCdG4uc3R5bGUuZGlzcGxheSA9IHRoaXMuc2VsZWN0ZWRUYWdzLnNpemUgPiAwID8gJ2lubGluZS1ibG9jaycgOiAnbm9uZSc7XG4gICAgICAgIGNsZWFyQnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICAgICAgdGhpcy5zZWxlY3RlZFRhZ3MuY2xlYXIoKTtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyVGFnRmlsdGVyKCk7XG4gICAgICAgICAgICB0aGlzLnJlbmRlckJvYXJkKCk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIEdldCBhbGwgdW5pcXVlIHRhZ3MgZnJvbSB0YXNrc1xuICAgIGdldEFsbFRhZ3MoKTogc3RyaW5nW10ge1xuICAgICAgICBjb25zdCB0YWdzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgICAgIGZvciAoY29uc3QgdGFzayBvZiB0aGlzLnRhc2tzKSB7XG4gICAgICAgICAgICBpZiAodGFzay50YWcpIHtcbiAgICAgICAgICAgICAgICB0YWdzLmFkZCh0YXNrLnRhZyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIEFycmF5LmZyb20odGFncykuc29ydCgpO1xuICAgIH1cblxuICAgIC8vIFJlbmRlciB0YWcgZmlsdGVyIGNoZWNrYm94ZXNcbiAgICByZW5kZXJUYWdGaWx0ZXIoKSB7XG4gICAgICAgIC8vIFJlbW92ZSBleGlzdGluZyBmaWx0ZXIgaWYgYW55XG4gICAgICAgIGlmICh0aGlzLnRhZ0ZpbHRlckNvbnRhaW5lcikge1xuICAgICAgICAgICAgdGhpcy50YWdGaWx0ZXJDb250YWluZXIucmVtb3ZlKCk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB0YWdzID0gdGhpcy5nZXRBbGxUYWdzKCk7XG4gICAgICAgIGlmICh0YWdzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuXG4gICAgICAgIHRoaXMudGFnRmlsdGVyQ29udGFpbmVyID0gdGhpcy5jb250YWluZXJFbC5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLXRhZy1maWx0ZXInIH0pO1xuICAgICAgICBcbiAgICAgICAgY29uc3QgZmlsdGVySGVhZGVyID0gdGhpcy50YWdGaWx0ZXJDb250YWluZXIuY3JlYXRlRGl2KHsgY2xzOiAndGFnLWZpbHRlci1oZWFkZXInIH0pO1xuICAgICAgICBmaWx0ZXJIZWFkZXIuY3JlYXRlU3Bhbih7IHRleHQ6ICdGaWx0ZXIgYnkgdGFnOicsIGNsczogJ3RhZy1maWx0ZXItbGFiZWwnIH0pO1xuXG4gICAgICAgIC8vIFNlbGVjdCBhbGwgLyBEZXNlbGVjdCBhbGwgYnV0dG9uc1xuICAgICAgICBjb25zdCBidG5Hcm91cCA9IGZpbHRlckhlYWRlci5jcmVhdGVEaXYoeyBjbHM6ICd0YWctZmlsdGVyLWJ1dHRvbnMnIH0pO1xuICAgICAgICBcbiAgICAgICAgY29uc3Qgc2VsZWN0QWxsQnRuID0gYnRuR3JvdXAuY3JlYXRlRWwoJ2J1dHRvbicsIHtcbiAgICAgICAgICAgIHRleHQ6ICdBbGwnLFxuICAgICAgICAgICAgY2xzOiAndGFnLWZpbHRlci1idG4nXG4gICAgICAgIH0pO1xuICAgICAgICBzZWxlY3RBbGxCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICB0YWdzLmZvckVhY2godGFnID0+IHRoaXMuc2VsZWN0ZWRUYWdzLmFkZCh0YWcpKTtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyVGFnRmlsdGVyKCk7XG4gICAgICAgICAgICB0aGlzLnJlbmRlckJvYXJkKCk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGNvbnN0IGRlc2VsZWN0QWxsQnRuID0gYnRuR3JvdXAuY3JlYXRlRWwoJ2J1dHRvbicsIHtcbiAgICAgICAgICAgIHRleHQ6ICdOb25lJyxcbiAgICAgICAgICAgIGNsczogJ3RhZy1maWx0ZXItYnRuJ1xuICAgICAgICB9KTtcbiAgICAgICAgZGVzZWxlY3RBbGxCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnNlbGVjdGVkVGFncy5jbGVhcigpO1xuICAgICAgICAgICAgdGhpcy5yZW5kZXJUYWdGaWx0ZXIoKTtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyQm9hcmQoKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gQ2hlY2tib3ggY29udGFpbmVyXG4gICAgICAgIGNvbnN0IGNoZWNrYm94Q29udGFpbmVyID0gdGhpcy50YWdGaWx0ZXJDb250YWluZXIuY3JlYXRlRGl2KHsgY2xzOiAndGFnLWNoZWNrYm94LWNvbnRhaW5lcicgfSk7XG5cbiAgICAgICAgZm9yIChjb25zdCB0YWcgb2YgdGFncykge1xuICAgICAgICAgICAgY29uc3QgbGFiZWwgPSBjaGVja2JveENvbnRhaW5lci5jcmVhdGVFbCgnbGFiZWwnLCB7IGNsczogJ3RhZy1jaGVja2JveC1sYWJlbCcgfSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnN0IGNoZWNrYm94ID0gbGFiZWwuY3JlYXRlRWwoJ2lucHV0Jywge1xuICAgICAgICAgICAgICAgIHR5cGU6ICdjaGVja2JveCcsXG4gICAgICAgICAgICAgICAgY2xzOiAndGFnLWNoZWNrYm94J1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBjaGVja2JveC5jaGVja2VkID0gdGhpcy5zZWxlY3RlZFRhZ3MuaGFzKHRhZyk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGxhYmVsLmNyZWF0ZVNwYW4oeyB0ZXh0OiB0YWcsIGNsczogJ3RhZy1jaGVja2JveC10ZXh0JyB9KTtcblxuICAgICAgICAgICAgLy8gQ291bnQgdGFza3Mgd2l0aCB0aGlzIHRhZ1xuICAgICAgICAgICAgY29uc3QgY291bnQgPSB0aGlzLnRhc2tzLmZpbHRlcih0ID0+IHQudGFnID09PSB0YWcpLmxlbmd0aDtcbiAgICAgICAgICAgIGxhYmVsLmNyZWF0ZVNwYW4oeyB0ZXh0OiBgKCR7Y291bnR9KWAsIGNsczogJ3RhZy1jaGVja2JveC1jb3VudCcgfSk7XG5cbiAgICAgICAgICAgIGNoZWNrYm94LmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoY2hlY2tib3guY2hlY2tlZCkge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLnNlbGVjdGVkVGFncy5hZGQodGFnKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLnNlbGVjdGVkVGFncy5kZWxldGUodGFnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdGhpcy5yZW5kZXJCb2FyZCgpO1xuICAgICAgICAgICAgICAgIC8vIFVwZGF0ZSBjbGVhciBidXR0b24gdmlzaWJpbGl0eVxuICAgICAgICAgICAgICAgIGNvbnN0IGNsZWFyQnRuID0gdGhpcy5jb250YWluZXJFbC5xdWVyeVNlbGVjdG9yKCcudGFzay1ib2FyZC1jbGVhci1maWx0ZXJzJykgYXMgSFRNTEVsZW1lbnQ7XG4gICAgICAgICAgICAgICAgaWYgKGNsZWFyQnRuKSB7XG4gICAgICAgICAgICAgICAgICAgIGNsZWFyQnRuLnN0eWxlLmRpc3BsYXkgPSB0aGlzLnNlbGVjdGVkVGFncy5zaXplID4gMCA/ICdpbmxpbmUtYmxvY2snIDogJ25vbmUnO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmVuZGVyQm9hcmQoKSB7XG4gICAgICAgIC8vIFJlbW92ZSBleGlzdGluZyBib2FyZCBpZiBhbnlcbiAgICAgICAgY29uc3QgZXhpc3RpbmdCb2FyZCA9IHRoaXMuY29udGFpbmVyRWwucXVlcnlTZWxlY3RvcignLnRhc2stYm9hcmQnKTtcbiAgICAgICAgaWYgKGV4aXN0aW5nQm9hcmQpIGV4aXN0aW5nQm9hcmQucmVtb3ZlKCk7XG5cbiAgICAgICAgY29uc3QgYm9hcmQgPSB0aGlzLmNvbnRhaW5lckVsLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stYm9hcmQnIH0pO1xuXG4gICAgICAgIC8vIEZpbHRlciB0YXNrcyBieSBzZWxlY3RlZCB0YWdzXG4gICAgICAgIGxldCBmaWx0ZXJlZFRhc2tzID0gdGhpcy50YXNrcztcbiAgICAgICAgaWYgKHRoaXMuc2VsZWN0ZWRUYWdzLnNpemUgPiAwKSB7XG4gICAgICAgICAgICBmaWx0ZXJlZFRhc2tzID0gdGhpcy50YXNrcy5maWx0ZXIodGFzayA9PiB0aGlzLnNlbGVjdGVkVGFncy5oYXModGFzay50YWcpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEdyb3VwIHRhc2tzIGJ5IHN0YXR1c1xuICAgICAgICBjb25zdCB0YXNrc0J5U3RhdHVzID0gbmV3IE1hcDxzdHJpbmcsIFRhc2tbXT4oKTtcbiAgICAgICAgXG4gICAgICAgIC8vIEluaXRpYWxpemUgd2l0aCBjb25maWd1cmVkIHN0YXR1cyBvcmRlclxuICAgICAgICBmb3IgKGNvbnN0IHN0YXR1cyBvZiB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zdGF0dXNPcmRlcikge1xuICAgICAgICAgICAgdGFza3NCeVN0YXR1cy5zZXQoc3RhdHVzLCBbXSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBHcm91cCB0YXNrc1xuICAgICAgICBmb3IgKGNvbnN0IHRhc2sgb2YgZmlsdGVyZWRUYXNrcykge1xuICAgICAgICAgICAgY29uc3Qgc3RhdHVzID0gdGFzay5zdGF0dXMgfHwgdGhpcy5wbHVnaW4uc2V0dGluZ3MuZGVmYXVsdFN0YXR1cztcbiAgICAgICAgICAgIGlmICghdGFza3NCeVN0YXR1cy5oYXMoc3RhdHVzKSkge1xuICAgICAgICAgICAgICAgIHRhc2tzQnlTdGF0dXMuc2V0KHN0YXR1cywgW10pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGFza3NCeVN0YXR1cy5nZXQoc3RhdHVzKSEucHVzaCh0YXNrKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFNvcnQgdGFza3Mgd2l0aGluIGVhY2ggY29sdW1uXG4gICAgICAgIGZvciAoY29uc3QgW3N0YXR1cywgdGFza3NdIG9mIHRhc2tzQnlTdGF0dXMpIHtcbiAgICAgICAgICAgIHRoaXMuc29ydFRhc2tzKHRhc2tzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENyZWF0ZSBjb2x1bW5zIChza2lwIGhpZGRlbiBzdGF0dXNlcylcbiAgICAgICAgZm9yIChjb25zdCBzdGF0dXMgb2YgdGhpcy5wbHVnaW4uc2V0dGluZ3Muc3RhdHVzT3JkZXIpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLmhpZGRlblN0YXR1c2VzLmhhcyhzdGF0dXMpKSBjb250aW51ZTtcbiAgICAgICAgICAgIGNvbnN0IHRhc2tzID0gdGFza3NCeVN0YXR1cy5nZXQoc3RhdHVzKSB8fCBbXTtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyQ29sdW1uKGJvYXJkLCBzdGF0dXMsIHRhc2tzKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHNvcnRUYXNrcyh0YXNrczogVGFza1tdKSB7XG4gICAgICAgIGNvbnN0IHNvcnRCeSA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnNvcnRCeTtcbiAgICAgICAgY29uc3QgZGlyZWN0aW9uID0gdGhpcy5wbHVnaW4uc2V0dGluZ3Muc29ydERpcmVjdGlvbjtcbiAgICAgICAgY29uc3QgbXVsdGlwbGllciA9IGRpcmVjdGlvbiA9PT0gJ2FzYycgPyAxIDogLTE7XG5cbiAgICAgICAgdGFza3Muc29ydCgoYSwgYikgPT4ge1xuICAgICAgICAgICAgbGV0IGNvbXBhcmlzb24gPSAwO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKHNvcnRCeSkge1xuICAgICAgICAgICAgICAgIGNhc2UgJ3ByaW9yaXR5JzpcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcHJpb3JpdHlNYXAgPSB7IGhpZ2g6IDMsIG1lZGl1bTogMiwgbG93OiAxIH07XG4gICAgICAgICAgICAgICAgICAgIGNvbXBhcmlzb24gPSBwcmlvcml0eU1hcFthLnByaW9yaXR5XSAtIHByaW9yaXR5TWFwW2IucHJpb3JpdHldO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlICd0YWcnOlxuICAgICAgICAgICAgICAgICAgICBjb21wYXJpc29uID0gYS50YWcubG9jYWxlQ29tcGFyZShiLnRhZyk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGNhc2UgJ3RpdGxlJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGFyaXNvbiA9IGEudGl0bGUubG9jYWxlQ29tcGFyZShiLnRpdGxlKTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgY2FzZSAnZm9sZGVyJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGFyaXNvbiA9IGEuZm9sZGVyLmxvY2FsZUNvbXBhcmUoYi5mb2xkZXIpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGNvbXBhcmlzb24gKiBtdWx0aXBsaWVyO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICByZW5kZXJDb2x1bW4oYm9hcmQ6IEhUTUxFbGVtZW50LCBzdGF0dXM6IHN0cmluZywgdGFza3M6IFRhc2tbXSkge1xuICAgICAgICBjb25zdCBjb2x1bW4gPSBib2FyZC5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLWJvYXJkLWNvbHVtbicgfSk7XG4gICAgICAgIGNvbHVtbi5zZXRBdHRyaWJ1dGUoJ2RhdGEtc3RhdHVzJywgc3RhdHVzKTtcblxuICAgICAgICAvLyBDb2x1bW4gaGVhZGVyXG4gICAgICAgIGNvbnN0IGhlYWRlciA9IGNvbHVtbi5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLWNvbHVtbi1oZWFkZXInIH0pO1xuICAgICAgICBjb25zdCBzdGF0dXNMYWJlbCA9IHRoaXMuZ2V0U3RhdHVzTGFiZWwoc3RhdHVzKTtcbiAgICAgICAgaGVhZGVyLmNyZWF0ZUVsKCdoMycsIHsgdGV4dDogc3RhdHVzTGFiZWwsIGNsczogYHRhc2stY29sdW1uLXRpdGxlIHN0YXR1cy0ke3N0YXR1c31gIH0pO1xuICAgICAgICBoZWFkZXIuY3JlYXRlU3Bhbih7IHRleHQ6IGAke3Rhc2tzLmxlbmd0aH1gLCBjbHM6ICd0YXNrLWNvdW50JyB9KTtcblxuICAgICAgICAvLyBUYXNrcyBjb250YWluZXJcbiAgICAgICAgY29uc3QgdGFza3NDb250YWluZXIgPSBjb2x1bW4uY3JlYXRlRGl2KHsgY2xzOiAndGFzay1jb2x1bW4tdGFza3MnIH0pO1xuXG4gICAgICAgIC8vIFJlbmRlciB0YXNrc1xuICAgICAgICBmb3IgKGNvbnN0IHRhc2sgb2YgdGFza3MpIHtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyVGFza0NhcmQodGFza3NDb250YWluZXIsIHRhc2spO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmVuZGVyVGFza0NhcmQoY29udGFpbmVyOiBIVE1MRWxlbWVudCwgdGFzazogVGFzaykge1xuICAgICAgICBjb25zdCBjYXJkID0gY29udGFpbmVyLmNyZWF0ZURpdih7IGNsczogYHRhc2stY2FyZCBwcmlvcml0eS0ke3Rhc2sucHJpb3JpdHl9YCB9KTtcblxuICAgICAgICAvLyBQcmlvcml0eSBpbmRpY2F0b3JcbiAgICAgICAgY29uc3QgcHJpb3JpdHlEb3QgPSBjYXJkLmNyZWF0ZURpdih7IGNsczogYHRhc2stcHJpb3JpdHkgcHJpb3JpdHktJHt0YXNrLnByaW9yaXR5fWAgfSk7XG4gICAgICAgIHByaW9yaXR5RG90LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKGUpID0+IHtcbiAgICAgICAgICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgICAgICAgICB0aGlzLnNob3dQcmlvcml0eU1lbnUodGFzaywgcHJpb3JpdHlEb3QsIGUpO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBUYXNrIHRpdGxlXG4gICAgICAgIGNvbnN0IHRpdGxlID0gY2FyZC5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLXRpdGxlJyB9KTtcbiAgICAgICAgdGl0bGUuY3JlYXRlRWwoJ2EnLCB7XG4gICAgICAgICAgICB0ZXh0OiB0YXNrLnRpdGxlLFxuICAgICAgICAgICAgaHJlZjogJyMnLFxuICAgICAgICAgICAgY2xzOiAndGFzay1saW5rJ1xuICAgICAgICB9KS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIChlKSA9PiB7XG4gICAgICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2Uub3BlbkxpbmtUZXh0KHRhc2suZmlsZS5wYXRoLCAnJyk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIFRhc2sgbWV0YVxuICAgICAgICBjb25zdCBtZXRhID0gY2FyZC5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLW1ldGEnIH0pO1xuXG4gICAgICAgIC8vIFRhZ1xuICAgICAgICBpZiAodGFzay50YWcgJiYgdGFzay50YWcgIT09ICd1bnRhZ2dlZCcpIHtcbiAgICAgICAgICAgIG1ldGEuY3JlYXRlU3Bhbih7IHRleHQ6IHRhc2sudGFnLCBjbHM6ICd0YXNrLXRhZycgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBGb2xkZXJcbiAgICAgICAgbWV0YS5jcmVhdGVTcGFuKHsgdGV4dDogdGFzay5mb2xkZXIsIGNsczogJ3Rhc2stZm9sZGVyJyB9KTtcblxuICAgICAgICAvLyBTdGF0dXMgY2hhbmdlIG9uIGNhcmQgY2xpY2tcbiAgICAgICAgY2FyZC5hZGRFdmVudExpc3RlbmVyKCdjb250ZXh0bWVudScsIChlKSA9PiB7XG4gICAgICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgICAgICB0aGlzLnNob3dTdGF0dXNNZW51KHRhc2ssIGUpO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBEcmFnIHN1cHBvcnRcbiAgICAgICAgY2FyZC5kcmFnZ2FibGUgPSB0cnVlO1xuICAgICAgICBjYXJkLmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdzdGFydCcsIChlKSA9PiB7XG4gICAgICAgICAgICBlLmRhdGFUcmFuc2Zlcj8uc2V0RGF0YSgndGV4dC9wbGFpbicsIHRhc2suaWQpO1xuICAgICAgICAgICAgY2FyZC5jbGFzc0xpc3QuYWRkKCdkcmFnZ2luZycpO1xuICAgICAgICB9KTtcbiAgICAgICAgY2FyZC5hZGRFdmVudExpc3RlbmVyKCdkcmFnZW5kJywgKCkgPT4ge1xuICAgICAgICAgICAgY2FyZC5jbGFzc0xpc3QucmVtb3ZlKCdkcmFnZ2luZycpO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBzaG93UHJpb3JpdHlNZW51KHRhc2s6IFRhc2ssIGVsZW1lbnQ6IEhUTUxFbGVtZW50LCBldnQ6IE1vdXNlRXZlbnQpIHtcbiAgICAgICAgY29uc3QgbWVudSA9IG5ldyBNZW51KCk7XG4gICAgICAgIFxuICAgICAgICBjb25zdCBwcmlvcml0aWVzID0gWydoaWdoJywgJ21lZGl1bScsICdsb3cnXSBhcyBjb25zdDtcbiAgICAgICAgZm9yIChjb25zdCBwcmlvcml0eSBvZiBwcmlvcml0aWVzKSB7XG4gICAgICAgICAgICBtZW51LmFkZEl0ZW0oKGl0ZW0pID0+IHtcbiAgICAgICAgICAgICAgICBpdGVtLnNldFRpdGxlKHByaW9yaXR5LmNoYXJBdCgwKS50b1VwcGVyQ2FzZSgpICsgcHJpb3JpdHkuc2xpY2UoMSkpXG4gICAgICAgICAgICAgICAgICAgIC5zZXRJY29uKHRhc2sucHJpb3JpdHkgPT09IHByaW9yaXR5ID8gJ2NoZWNrJyA6ICcnKVxuICAgICAgICAgICAgICAgICAgICAub25DbGljayhhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi51cGRhdGVUYXNrUHJpb3JpdHkodGFzaywgcHJpb3JpdHkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5yZWZyZXNoKCk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBtZW51LnNob3dBdE1vdXNlRXZlbnQoZXZ0KTtcbiAgICB9XG5cbiAgICBzaG93U3RhdHVzTWVudSh0YXNrOiBUYXNrLCBldnQ6IE1vdXNlRXZlbnQpIHtcbiAgICAgICAgY29uc3QgbWVudSA9IG5ldyBNZW51KCk7XG4gICAgICAgIFxuICAgICAgICBmb3IgKGNvbnN0IHN0YXR1cyBvZiB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zdGF0dXNPcmRlcikge1xuICAgICAgICAgICAgbWVudS5hZGRJdGVtKChpdGVtKSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgbGFiZWwgPSB0aGlzLmdldFN0YXR1c0xhYmVsKHN0YXR1cyk7XG4gICAgICAgICAgICAgICAgaXRlbS5zZXRUaXRsZShsYWJlbClcbiAgICAgICAgICAgICAgICAgICAgLnNldEljb24odGFzay5zdGF0dXMgPT09IHN0YXR1cyA/ICdjaGVjaycgOiAnJylcbiAgICAgICAgICAgICAgICAgICAgLm9uQ2xpY2soYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4udXBkYXRlVGFza1N0YXR1cyh0YXNrLCBzdGF0dXMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5yZWZyZXNoKCk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBtZW51LnNob3dBdE1vdXNlRXZlbnQoZXZ0KTtcbiAgICB9XG5cbiAgICBnZXRTdGF0dXNMYWJlbChzdGF0dXM6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgICAgIGNvbnN0IGxhYmVsczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICAgICAgICAgICd0b2RvJzogJ1RvIERvJyxcbiAgICAgICAgICAgICdpbi1wcm9ncmVzcyc6ICdJbiBQcm9ncmVzcycsXG4gICAgICAgICAgICAnZG9uZSc6ICdEb25lJyxcbiAgICAgICAgICAgICdhcmNoaXZlJzogJ0FyY2hpdmUnXG4gICAgICAgIH07XG4gICAgICAgIHJldHVybiBsYWJlbHNbc3RhdHVzXSB8fCBzdGF0dXMuY2hhckF0KDApLnRvVXBwZXJDYXNlKCkgKyBzdGF0dXMuc2xpY2UoMSk7XG4gICAgfVxufVxuXG4vLyBTZXR0aW5ncyBUYWJcbmNsYXNzIFRhc2tCb2FyZFNldHRpbmdUYWIgZXh0ZW5kcyBQbHVnaW5TZXR0aW5nVGFiIHtcbiAgICBwbHVnaW46IFRhc2tCb2FyZFBsdWdpbjtcblxuICAgIGNvbnN0cnVjdG9yKGFwcDogQXBwLCBwbHVnaW46IFRhc2tCb2FyZFBsdWdpbikge1xuICAgICAgICBzdXBlcihhcHAsIHBsdWdpbik7XG4gICAgICAgIHRoaXMucGx1Z2luID0gcGx1Z2luO1xuICAgIH1cblxuICAgIGRpc3BsYXkoKTogdm9pZCB7XG4gICAgICAgIGNvbnN0IHsgY29udGFpbmVyRWwgfSA9IHRoaXM7XG4gICAgICAgIGNvbnRhaW5lckVsLmVtcHR5KCk7XG5cbiAgICAgICAgY29udGFpbmVyRWwuY3JlYXRlRWwoJ2gyJywgeyB0ZXh0OiAnVGFzayBCb2FyZCBTZXR0aW5ncycgfSk7XG5cbiAgICAgICAgLy8gVGFzayBmb2xkZXJzXG4gICAgICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgICAgICAgLnNldE5hbWUoJ1Rhc2sgZm9sZGVyIG5hbWVzJylcbiAgICAgICAgICAgIC5zZXREZXNjKCdOYW1lcyBvZiBmb2xkZXJzIHRoYXQgY29udGFpbiB0YXNrcyAoY29tbWEtc2VwYXJhdGVkKS4gV2lsbCBzZWFyY2ggaW4gc3ViZm9sZGVycyByZWN1cnNpdmVseS4nKVxuICAgICAgICAgICAgLmFkZFRleHQodGV4dCA9PiB0ZXh0XG4gICAgICAgICAgICAgICAgLnNldFBsYWNlaG9sZGVyKCd0YXNrcywgdG9kbywgaXNzdWVzJylcbiAgICAgICAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MudGFza0ZvbGRlcnMuam9pbignLCAnKSlcbiAgICAgICAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLnRhc2tGb2xkZXJzID0gdmFsdWVcbiAgICAgICAgICAgICAgICAgICAgICAgIC5zcGxpdCgnLCcpXG4gICAgICAgICAgICAgICAgICAgICAgICAubWFwKHMgPT4gcy50cmltKCkpXG4gICAgICAgICAgICAgICAgICAgICAgICAuZmlsdGVyKHMgPT4gcy5sZW5ndGggPiAwKTtcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgICAgICAgfSkpO1xuXG4gICAgICAgIC8vIFN0YXR1cyBvcmRlclxuICAgICAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgICAgICAgIC5zZXROYW1lKCdTdGF0dXMgY29sdW1ucycpXG4gICAgICAgICAgICAuc2V0RGVzYygnT3JkZXIgb2Ygc3RhdHVzIGNvbHVtbnMgKGNvbW1hLXNlcGFyYXRlZCknKVxuICAgICAgICAgICAgLmFkZFRleHQodGV4dCA9PiB0ZXh0XG4gICAgICAgICAgICAgICAgLnNldFBsYWNlaG9sZGVyKCd0b2RvLCBpbi1wcm9ncmVzcywgZG9uZSwgYXJjaGl2ZScpXG4gICAgICAgICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLnN0YXR1c09yZGVyLmpvaW4oJywgJykpXG4gICAgICAgICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zdGF0dXNPcmRlciA9IHZhbHVlXG4gICAgICAgICAgICAgICAgICAgICAgICAuc3BsaXQoJywnKVxuICAgICAgICAgICAgICAgICAgICAgICAgLm1hcChzID0+IHMudHJpbSgpKVxuICAgICAgICAgICAgICAgICAgICAgICAgLmZpbHRlcihzID0+IHMubGVuZ3RoID4gMCk7XG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgICAgIH0pKTtcblxuICAgICAgICAvLyBEZWZhdWx0IHN0YXR1c1xuICAgICAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgICAgICAgIC5zZXROYW1lKCdEZWZhdWx0IHN0YXR1cycpXG4gICAgICAgICAgICAuc2V0RGVzYygnRGVmYXVsdCBzdGF0dXMgZm9yIHRhc2tzIHdpdGhvdXQgZnJvbnRtYXR0ZXInKVxuICAgICAgICAgICAgLmFkZFRleHQodGV4dCA9PiB0ZXh0XG4gICAgICAgICAgICAgICAgLnNldFBsYWNlaG9sZGVyKCd0b2RvJylcbiAgICAgICAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuZGVmYXVsdFN0YXR1cylcbiAgICAgICAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLmRlZmF1bHRTdGF0dXMgPSB2YWx1ZS50cmltKCkgfHwgJ3RvZG8nO1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICAgICAgICB9KSk7XG4gICAgfVxufVxuIl19