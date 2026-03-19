"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const obsidian_1 = require("obsidian");
const DEFAULT_SETTINGS = {
    taskFolders: ['tasks'],
    statusOrder: ['todo', 'in-progress', 'done', 'archive'],
    defaultStatus: 'todo',
    sortBy: 'priority',
    sortDirection: 'desc',
    organizeByTag: false
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
        this.plugin = plugin;
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
        // Create columns
        for (const status of this.plugin.settings.statusOrder) {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1haW4udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSx1Q0FnQmtCO0FBd0JsQixNQUFNLGdCQUFnQixHQUFzQjtJQUN4QyxXQUFXLEVBQUUsQ0FBQyxPQUFPLENBQUM7SUFDdEIsV0FBVyxFQUFFLENBQUMsTUFBTSxFQUFFLGFBQWEsRUFBRSxNQUFNLEVBQUUsU0FBUyxDQUFDO0lBQ3ZELGFBQWEsRUFBRSxNQUFNO0lBQ3JCLE1BQU0sRUFBRSxVQUFVO0lBQ2xCLGFBQWEsRUFBRSxNQUFNO0lBQ3JCLGFBQWEsRUFBRSxLQUFLO0NBQ3ZCLENBQUM7QUFFRixNQUFNLG9CQUFvQixHQUFHLGlCQUFpQixDQUFDO0FBRS9DLG9CQUFvQjtBQUNwQixNQUFxQixlQUFnQixTQUFRLGlCQUFNO0lBRy9DLEtBQUssQ0FBQyxNQUFNO1FBQ1IsTUFBTSxJQUFJLENBQUMsWUFBWSxFQUFFLENBQUM7UUFFMUIsMkJBQTJCO1FBQzNCLElBQUksQ0FBQyxZQUFZLENBQ2Isb0JBQW9CLEVBQ3BCLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxJQUFJLGFBQWEsQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLENBQzFDLENBQUM7UUFFRixrQkFBa0I7UUFDbEIsSUFBSSxDQUFDLGFBQWEsQ0FBQyxjQUFjLEVBQUUsaUJBQWlCLEVBQUUsR0FBRyxFQUFFO1lBQ3ZELElBQUksQ0FBQyxZQUFZLEVBQUUsQ0FBQztRQUN4QixDQUFDLENBQUMsQ0FBQztRQUVILGdDQUFnQztRQUNoQyxJQUFJLENBQUMsVUFBVSxDQUFDO1lBQ1osRUFBRSxFQUFFLGlCQUFpQjtZQUNyQixJQUFJLEVBQUUsaUJBQWlCO1lBQ3ZCLFFBQVEsRUFBRSxHQUFHLEVBQUU7Z0JBQ1gsSUFBSSxDQUFDLFlBQVksRUFBRSxDQUFDO1lBQ3hCLENBQUM7U0FDSixDQUFDLENBQUM7UUFFSCxzQ0FBc0M7UUFDdEMsSUFBSSxDQUFDLFVBQVUsQ0FBQztZ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Q0FBQzthQUN0QixRQUFRLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsYUFBYSxDQUFDO2FBQzVDLFFBQVEsQ0FBQyxLQUFLLEVBQUUsS0FBSyxFQUFFLEVBQUU7WUFDdEIsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsYUFBYSxHQUFHLEtBQUssQ0FBQyxJQUFJLEVBQUUsSUFBSSxNQUFNLENBQUM7WUFDNUQsTUFBTSxJQUFJLENBQUMsTUFBTSxDQUFDLFlBQVksRUFBRSxDQUFDO1FBQ3JDLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDaEIsQ0FBQztDQUNKIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHtcbiAgICBBcHAsXG4gICAgUGx1Z2luLFxuICAgIFBsdWdpblNldHRpbmdUYWIsXG4gICAgU2V0dGluZyxcbiAgICBURmlsZSxcbiAgICBURm9sZGVyLFxuICAgIEl0ZW1WaWV3LFxuICAgIFdvcmtzcGFjZUxlYWYsXG4gICAgTm90aWNlLFxuICAgIE1lbnUsXG4gICAgVGV4dENvbXBvbmVudCxcbiAgICBEcm9wZG93bkNvbXBvbmVudCxcbiAgICBCdXR0b25Db21wb25lbnQsXG4gICAgTWFya2Rvd25SZW5kZXJlcixcbiAgICBDb21wb25lbnRcbn0gZnJvbSAnb2JzaWRpYW4nO1xuXG4vLyBUYXNrIGludGVyZmFjZVxuaW50ZXJmYWNlIFRhc2sge1xuICAgIGlkOiBzdHJpbmc7XG4gICAgZmlsZTogVEZpbGU7XG4gICAgdGl0bGU6IHN0cmluZztcbiAgICBzdGF0dXM6IHN0cmluZztcbiAgICB0YWc6IHN0cmluZztcbiAgICBwcmlvcml0eTogJ2hpZ2gnIHwgJ21lZGl1bScgfCAnbG93JztcbiAgICBjb250ZW50OiBzdHJpbmc7XG4gICAgZm9sZGVyOiBzdHJpbmc7XG59XG5cbi8vIFBsdWdpbiBzZXR0aW5nc1xuaW50ZXJmYWNlIFRhc2tCb2FyZFNldHRpbmdzIHtcbiAgICB0YXNrRm9sZGVyczogc3RyaW5nW107XG4gICAgc3RhdHVzT3JkZXI6IHN0cmluZ1tdO1xuICAgIGRlZmF1bHRTdGF0dXM6IHN0cmluZztcbiAgICBzb3J0Qnk6ICdwcmlvcml0eScgfCAndGFnJyB8ICd0aXRsZScgfCAnZm9sZGVyJztcbiAgICBzb3J0RGlyZWN0aW9uOiAnYXNjJyB8ICdkZXNjJztcbiAgICBvcmdhbml6ZUJ5VGFnOiBib29sZWFuO1xufVxuXG5jb25zdCBERUZBVUxUX1NFVFRJTkdTOiBUYXNrQm9hcmRTZXR0aW5ncyA9IHtcbiAgICB0YXNrRm9sZGVyczogWyd0YXNrcyddLFxuICAgIHN0YXR1c09yZGVyOiBbJ3RvZG8nLCAnaW4tcHJvZ3Jlc3MnLCAnZG9uZScsICdhcmNoaXZlJ10sXG4gICAgZGVmYXVsdFN0YXR1czogJ3RvZG8nLFxuICAgIHNvcnRCeTogJ3ByaW9yaXR5JyxcbiAgICBzb3J0RGlyZWN0aW9uOiAnZGVzYycsXG4gICAgb3JnYW5pemVCeVRhZzogZmFsc2Vcbn07XG5cbmNvbnN0IFZJRVdfVFlQRV9UQVNLX0JPQVJEID0gJ3Rhc2stYm9hcmQtdmlldyc7XG5cbi8vIE1haW4gUGx1Z2luIENsYXNzXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBUYXNrQm9hcmRQbHVnaW4gZXh0ZW5kcyBQbHVnaW4ge1xuICAgIHNldHRpbmdzOiBUYXNrQm9hcmRTZXR0aW5ncztcblxuICAgIGFzeW5jIG9ubG9hZCgpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5sb2FkU2V0dGluZ3MoKTtcblxuICAgICAgICAvLyBSZWdpc3RlciB0aGUgY3VzdG9tIHZpZXdcbiAgICAgICAgdGhpcy5yZWdpc3RlclZpZXcoXG4gICAgICAgICAgICBWSUVXX1RZUEVfVEFTS19CT0FSRCxcbiAgICAgICAgICAgIChsZWFmKSA9PiBuZXcgVGFza0JvYXJkVmlldyhsZWFmLCB0aGlzKVxuICAgICAgICApO1xuXG4gICAgICAgIC8vIEFkZCByaWJib24gaWNvblxuICAgICAgICB0aGlzLmFkZFJpYmJvbkljb24oJ2xheW91dC1ib2FyZCcsICdPcGVuIFRhc2sgQm9hcmQnLCAoKSA9PiB7XG4gICAgICAgICAgICB0aGlzLmFjdGl2YXRlVmlldygpO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBBZGQgY29tbWFuZCAtIE9wZW4gVGFzayBCb2FyZFxuICAgICAgICB0aGlzLmFkZENvbW1hbmQoe1xuICAgICAgICAgICAgaWQ6ICdvcGVuLXRhc2stYm9hcmQnLFxuICAgICAgICAgICAgbmFtZTogJ09wZW4gVGFzayBCb2FyZCcsXG4gICAgICAgICAgICBjYWxsYmFjazogKCkgPT4ge1xuICAgICAgICAgICAgICAgIHRoaXMuYWN0aXZhdGVWaWV3KCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIEFkZCBjb21tYW5kIC0gT3JnYW5pemUgdGFza3MgYnkgdGFnXG4gICAgICAgIHRoaXMuYWRkQ29tbWFuZCh7XG4gICAgICAgICAgICBpZDogJ29yZ2FuaXplLXRhc2tzLWJ5LXRhZycsXG4gICAgICAgICAgICBuYW1lOiAnT3JnYW5pemUgdGFza3MgYnkgdGFnJyxcbiAgICAgICAgICAgIGNhbGxiYWNrOiBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5vcmdhbml6ZVRhc2tzQnlUYWcoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gQWRkIGNvbW1hbmQgLSBPcmdhbml6ZSB0YXNrcyBpbiBjdXJyZW50IGZvbGRlclxuICAgICAgICB0aGlzLmFkZENvbW1hbmQoe1xuICAgICAgICAgICAgaWQ6ICdvcmdhbml6ZS10YXNrcy1pbi1jdXJyZW50LWZvbGRlcicsXG4gICAgICAgICAgICBuYW1lOiAnT3JnYW5pemUgdGFza3MgaW4gY3VycmVudCBmb2xkZXIgYnkgdGFnJyxcbiAgICAgICAgICAgIGNoZWNrQ2FsbGJhY2s6IChjaGVja2luZzogYm9vbGVhbikgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IGZpbGUgPSB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0QWN0aXZlRmlsZSgpO1xuICAgICAgICAgICAgICAgIGlmIChmaWxlKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghY2hlY2tpbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGZvbGRlciA9IGZpbGUucGFyZW50O1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZvbGRlcikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMub3JnYW5pemVUYXNrc0luRm9sZGVyKGZvbGRlcik7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gQWRkIHNldHRpbmdzIHRhYlxuICAgICAgICB0aGlzLmFkZFNldHRpbmdUYWIobmV3IFRhc2tCb2FyZFNldHRpbmdUYWIodGhpcy5hcHAsIHRoaXMpKTtcblxuICAgICAgICAvLyBSZWZyZXNoIHZpZXcgd2hlbiBmaWxlcyBjaGFuZ2VcbiAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KFxuICAgICAgICAgICAgdGhpcy5hcHAudmF1bHQub24oJ2NyZWF0ZScsICgpID0+IHRoaXMucmVmcmVzaFZpZXcoKSlcbiAgICAgICAgKTtcbiAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KFxuICAgICAgICAgICAgdGhpcy5hcHAudmF1bHQub24oJ2RlbGV0ZScsICgpID0+IHRoaXMucmVmcmVzaFZpZXcoKSlcbiAgICAgICAgKTtcbiAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KFxuICAgICAgICAgICAgdGhpcy5hcHAudmF1bHQub24oJ3JlbmFtZScsICgpID0+IHRoaXMucmVmcmVzaFZpZXcoKSlcbiAgICAgICAgKTtcbiAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KFxuICAgICAgICAgICAgdGhpcy5hcHAubWV0YWRhdGFDYWNoZS5vbignY2hhbmdlZCcsICgpID0+IHRoaXMucmVmcmVzaFZpZXcoKSlcbiAgICAgICAgKTtcbiAgICB9XG5cbiAgICBvbnVubG9hZCgpIHtcbiAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLmRldGFjaExlYXZlc09mVHlwZShWSUVXX1RZUEVfVEFTS19CT0FSRCk7XG4gICAgfVxuXG4gICAgYXN5bmMgbG9hZFNldHRpbmdzKCkge1xuICAgICAgICB0aGlzLnNldHRpbmdzID0gT2JqZWN0LmFzc2lnbih7fSwgREVGQVVMVF9TRVRUSU5HUywgYXdhaXQgdGhpcy5sb2FkRGF0YSgpKTtcbiAgICB9XG5cbiAgICBhc3luYyBzYXZlU2V0dGluZ3MoKSB7XG4gICAgICAgIGF3YWl0IHRoaXMuc2F2ZURhdGEodGhpcy5zZXR0aW5ncyk7XG4gICAgICAgIHRoaXMucmVmcmVzaFZpZXcoKTtcbiAgICB9XG5cbiAgICBhc3luYyBhY3RpdmF0ZVZpZXcoKSB7XG4gICAgICAgIGNvbnN0IHsgd29ya3NwYWNlIH0gPSB0aGlzLmFwcDtcblxuICAgICAgICBsZXQgbGVhZjogV29ya3NwYWNlTGVhZiB8IG51bGwgPSBudWxsO1xuICAgICAgICBjb25zdCBsZWF2ZXMgPSB3b3Jrc3BhY2UuZ2V0TGVhdmVzT2ZUeXBlKFZJRVdfVFlQRV9UQVNLX0JPQVJEKTtcblxuICAgICAgICBpZiAobGVhdmVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGxlYWYgPSBsZWF2ZXNbMF07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyBDcmVhdGUgaW4gbWFpbiB2aWV3IGFyZWEgaW5zdGVhZCBvZiBzaWRlYmFyXG4gICAgICAgICAgICBsZWFmID0gd29ya3NwYWNlLmdldExlYWYoJ3RhYicpO1xuICAgICAgICAgICAgYXdhaXQgbGVhZi5zZXRWaWV3U3RhdGUoeyB0eXBlOiBWSUVXX1RZUEVfVEFTS19CT0FSRCwgYWN0aXZlOiB0cnVlIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgd29ya3NwYWNlLnJldmVhbExlYWYobGVhZik7XG4gICAgfVxuXG4gICAgcmVmcmVzaFZpZXcoKSB7XG4gICAgICAgIGNvbnN0IGxlYXZlcyA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRMZWF2ZXNPZlR5cGUoVklFV19UWVBFX1RBU0tfQk9BUkQpO1xuICAgICAgICBmb3IgKGNvbnN0IGxlYWYgb2YgbGVhdmVzKSB7XG4gICAgICAgICAgICBjb25zdCB2aWV3ID0gbGVhZi52aWV3IGFzIFRhc2tCb2FyZFZpZXc7XG4gICAgICAgICAgICB2aWV3LnJlZnJlc2goKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIFJlY3Vyc2l2ZWx5IGNvbGxlY3QgYWxsIG1hcmtkb3duIGZpbGVzIGZyb20gYSBmb2xkZXIgYW5kIGl0cyBzdWJmb2xkZXJzXG4gICAgcHJpdmF0ZSBjb2xsZWN0TWFya2Rvd25GaWxlcyhmb2xkZXI6IFRGb2xkZXIpOiBURmlsZVtdIHtcbiAgICAgICAgY29uc3QgZmlsZXM6IFRGaWxlW10gPSBbXTtcbiAgICAgICAgXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgZm9sZGVyLmNoaWxkcmVuKSB7XG4gICAgICAgICAgICBpZiAoY2hpbGQgaW5zdGFuY2VvZiBURmlsZSAmJiBjaGlsZC5leHRlbnNpb24gPT09ICdtZCcpIHtcbiAgICAgICAgICAgICAgICBmaWxlcy5wdXNoKGNoaWxkKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoY2hpbGQgaW5zdGFuY2VvZiBURm9sZGVyKSB7XG4gICAgICAgICAgICAgICAgLy8gUmVjdXJzaXZlbHkgZ2V0IGZpbGVzIGZyb20gc3ViZm9sZGVyc1xuICAgICAgICAgICAgICAgIGZpbGVzLnB1c2goLi4udGhpcy5jb2xsZWN0TWFya2Rvd25GaWxlcyhjaGlsZCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gZmlsZXM7XG4gICAgfVxuXG4gICAgLy8gU2NhbiBhbGwgdGFzayBmb2xkZXJzIGFuZCByZXR1cm4gdGFza3MgKGluY2x1ZGluZyBzdWJmb2xkZXJzKVxuICAgIGFzeW5jIHNjYW5UYXNrcygpOiBQcm9taXNlPFRhc2tbXT4ge1xuICAgICAgICBjb25zdCB0YXNrczogVGFza1tdID0gW107XG4gICAgICAgIGNvbnN0IHZhdWx0ID0gdGhpcy5hcHAudmF1bHQ7XG5cbiAgICAgICAgLy8gR2V0IGFsbCBmb2xkZXJzIGluIHZhdWx0XG4gICAgICAgIGNvbnN0IGFsbEZvbGRlcnMgPSB2YXVsdC5nZXRBbGxMb2FkZWRGaWxlcygpXG4gICAgICAgICAgICAuZmlsdGVyKGYgPT4gZiBpbnN0YW5jZW9mIFRGb2xkZXIpIGFzIFRGb2xkZXJbXTtcblxuICAgICAgICAvLyBGaW5kIHRhc2sgZm9sZGVycyAoZXhhY3QgbWF0Y2hlcyBvciBmb2xkZXJzIGVuZGluZyB3aXRoIC90YXNrcywgZXRjLilcbiAgICAgICAgY29uc3QgdGFza0ZvbGRlcnM6IFRGb2xkZXJbXSA9IFtdO1xuICAgICAgICBmb3IgKGNvbnN0IGZvbGRlciBvZiBhbGxGb2xkZXJzKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5zZXR0aW5ncy50YXNrRm9sZGVycy5zb21lKHRmID0+IFxuICAgICAgICAgICAgICAgIGZvbGRlci5wYXRoID09PSB0ZiB8fCBcbiAgICAgICAgICAgICAgICBmb2xkZXIucGF0aC5lbmRzV2l0aCgnLycgKyB0ZikgfHxcbiAgICAgICAgICAgICAgICBmb2xkZXIubmFtZSA9PT0gdGZcbiAgICAgICAgICAgICkpIHtcbiAgICAgICAgICAgICAgICB0YXNrRm9sZGVycy5wdXNoKGZvbGRlcik7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBTY2FuIGVhY2ggdGFzayBmb2xkZXIgcmVjdXJzaXZlbHlcbiAgICAgICAgZm9yIChjb25zdCBmb2xkZXIgb2YgdGFza0ZvbGRlcnMpIHtcbiAgICAgICAgICAgIC8vIFJlY3Vyc2l2ZWx5IGNvbGxlY3QgYWxsIG1hcmtkb3duIGZpbGVzIGluY2x1ZGluZyBzdWJmb2xkZXJzXG4gICAgICAgICAgICBjb25zdCBmaWxlcyA9IHRoaXMuY29sbGVjdE1hcmtkb3duRmlsZXMoZm9sZGVyKTtcblxuICAgICAgICAgICAgZm9yIChjb25zdCBmaWxlIG9mIGZpbGVzKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgdGFzayA9IGF3YWl0IHRoaXMucGFyc2VUYXNrRmlsZShmaWxlLCBmb2xkZXIpO1xuICAgICAgICAgICAgICAgIGlmICh0YXNrKSB7XG4gICAgICAgICAgICAgICAgICAgIHRhc2tzLnB1c2godGFzayk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRhc2tzO1xuICAgIH1cblxuICAgIC8vIFBhcnNlIGEgdGFzayBmaWxlIGFuZCBleHRyYWN0IG1ldGFkYXRhXG4gICAgYXN5bmMgcGFyc2VUYXNrRmlsZShmaWxlOiBURmlsZSwgZm9sZGVyOiBURm9sZGVyKTogUHJvbWlzZTxUYXNrIHwgbnVsbD4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgY2FjaGUgPSB0aGlzLmFwcC5tZXRhZGF0YUNhY2hlLmdldEZpbGVDYWNoZShmaWxlKTtcbiAgICAgICAgICAgIGNvbnN0IGZyb250bWF0dGVyID0gY2FjaGU/LmZyb250bWF0dGVyO1xuXG4gICAgICAgICAgICAvLyBSZWFkIGZpbGUgY29udGVudCBmb3IgdGl0bGUgKGZpcnN0IGxpbmUgb3IgaDEpXG4gICAgICAgICAgICBjb25zdCBjb250ZW50ID0gYXdhaXQgdGhpcy5hcHAudmF1bHQucmVhZChmaWxlKTtcbiAgICAgICAgICAgIGxldCB0aXRsZSA9IGZpbGUuYmFzZW5hbWU7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIFRyeSB0byBmaW5kIGEgYmV0dGVyIHRpdGxlIGZyb20gY29udGVudFxuICAgICAgICAgICAgY29uc3QgbGluZXMgPSBjb250ZW50LnNwbGl0KCdcXG4nKTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgICAgICAgICAgICAgIGNvbnN0IHRyaW1tZWQgPSBsaW5lLnRyaW0oKTtcbiAgICAgICAgICAgICAgICBpZiAodHJpbW1lZCAmJiAhdHJpbW1lZC5zdGFydHNXaXRoKCctLS0nKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAodHJpbW1lZC5zdGFydHNXaXRoKCcjICcpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aXRsZSA9IHRyaW1tZWQuc3Vic3RyaW5nKDIpLnRyaW0oKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIEdldCBwYXJlbnQgZm9sZGVyIG5hbWUgYXMgY2F0ZWdvcnlcbiAgICAgICAgICAgIGNvbnN0IGZvbGRlclBhcnRzID0gZm9sZGVyLnBhdGguc3BsaXQoJy8nKTtcbiAgICAgICAgICAgIGNvbnN0IHBhcmVudEZvbGRlciA9IGZvbGRlclBhcnRzLmxlbmd0aCA+IDEgPyBmb2xkZXJQYXJ0c1tmb2xkZXJQYXJ0cy5sZW5ndGggLSAyXSA6ICdSb290JztcblxuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBpZDogZmlsZS5wYXRoLFxuICAgICAgICAgICAgICAgIGZpbGU6IGZpbGUsXG4gICAgICAgICAgICAgICAgdGl0bGU6IHRpdGxlLFxuICAgICAgICAgICAgICAgIHN0YXR1czogZnJvbnRtYXR0ZXI/LnN0YXR1cyB8fCB0aGlzLnNldHRpbmdzLmRlZmF1bHRTdGF0dXMsXG4gICAgICAgICAgICAgICAgdGFnOiBmcm9udG1hdHRlcj8udGFnIHx8ICd1bnRhZ2dlZCcsXG4gICAgICAgICAgICAgICAgcHJpb3JpdHk6IChmcm9udG1hdHRlcj8ucHJpb3JpdHkgfHwgJ21lZGl1bScpIGFzICdoaWdoJyB8ICdtZWRpdW0nIHwgJ2xvdycsXG4gICAgICAgICAgICAgICAgY29udGVudDogY29udGVudCxcbiAgICAgICAgICAgICAgICBmb2xkZXI6IHBhcmVudEZvbGRlclxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIHBhcnNpbmcgdGFzayBmaWxlOicsIGZpbGUucGF0aCwgZXJyb3IpO1xuICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBVcGRhdGUgdGFzayBzdGF0dXNcbiAgICBhc3luYyB1cGRhdGVUYXNrU3RhdHVzKHRhc2s6IFRhc2ssIG5ld1N0YXR1czogc3RyaW5nKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBjYWNoZSA9IHRoaXMuYXBwLm1ldGFkYXRhQ2FjaGUuZ2V0RmlsZUNhY2hlKHRhc2suZmlsZSk7XG4gICAgICAgICAgICBjb25zdCBmcm9udG1hdHRlciA9IGNhY2hlPy5mcm9udG1hdHRlcjtcblxuICAgICAgICAgICAgaWYgKGZyb250bWF0dGVyKSB7XG4gICAgICAgICAgICAgICAgLy8gVXBkYXRlIGZyb250bWF0dGVyXG4gICAgICAgICAgICAgICAgY29uc3QgY29udGVudCA9IGF3YWl0IHRoaXMuYXBwLnZhdWx0LnJlYWQodGFzay5maWxlKTtcbiAgICAgICAgICAgICAgICBjb25zdCBmcm9udG1hdHRlclJlZ2V4ID0gL14tLS1cXG4oW1xcc1xcU10qPylcXG4tLS0vO1xuICAgICAgICAgICAgICAgIGNvbnN0IG1hdGNoID0gY29udGVudC5tYXRjaChmcm9udG1hdHRlclJlZ2V4KTtcblxuICAgICAgICAgICAgICAgIGlmIChtYXRjaCkge1xuICAgICAgICAgICAgICAgICAgICBsZXQgbmV3RnJvbnRtYXR0ZXIgPSBtYXRjaFsxXTtcbiAgICAgICAgICAgICAgICAgICAgLy8gUmVwbGFjZSBzdGF0dXMgbGluZVxuICAgICAgICAgICAgICAgICAgICBuZXdGcm9udG1hdHRlciA9IG5ld0Zyb250bWF0dGVyLnJlcGxhY2UoXG4gICAgICAgICAgICAgICAgICAgICAgICAvc3RhdHVzOlxccypcXHcrLyxcbiAgICAgICAgICAgICAgICAgICAgICAgIGBzdGF0dXM6ICR7bmV3U3RhdHVzfWBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgLy8gSWYgc3RhdHVzIGRvZXNuJ3QgZXhpc3QsIGFkZCBpdFxuICAgICAgICAgICAgICAgICAgICBpZiAoIW5ld0Zyb250bWF0dGVyLmluY2x1ZGVzKCdzdGF0dXM6JykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG5ld0Zyb250bWF0dGVyID0gYHN0YXR1czogJHtuZXdTdGF0dXN9XFxuJHtuZXdGcm9udG1hdHRlcn1gO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbmV3Q29udGVudCA9IGNvbnRlbnQucmVwbGFjZShmcm9udG1hdHRlclJlZ2V4LCBgLS0tXFxuJHtuZXdGcm9udG1hdHRlcn1cXG4tLS1gKTtcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hcHAudmF1bHQubW9kaWZ5KHRhc2suZmlsZSwgbmV3Q29udGVudCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyBBZGQgZnJvbnRtYXR0ZXIgaWYgaXQgZG9lc24ndCBleGlzdFxuICAgICAgICAgICAgICAgIGNvbnN0IG5ld0Zyb250bWF0dGVyID0gYC0tLVxcbnN0YXR1czogJHtuZXdTdGF0dXN9XFxudGFnOiAke3Rhc2sudGFnfVxcbnByaW9yaXR5OiAke3Rhc2sucHJpb3JpdHl9XFxuLS0tXFxuXFxuYDtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5tb2RpZnkodGFzay5maWxlLCBuZXdGcm9udG1hdHRlciArIHRhc2suY29udGVudCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRhc2suc3RhdHVzID0gbmV3U3RhdHVzO1xuICAgICAgICAgICAgbmV3IE5vdGljZShgVGFzayBtb3ZlZCB0byAke25ld1N0YXR1c31gKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIHVwZGF0aW5nIHRhc2sgc3RhdHVzOicsIGVycm9yKTtcbiAgICAgICAgICAgIG5ldyBOb3RpY2UoJ0ZhaWxlZCB0byB1cGRhdGUgdGFzayBzdGF0dXMnKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIFVwZGF0ZSB0YXNrIHByaW9yaXR5XG4gICAgYXN5bmMgdXBkYXRlVGFza1ByaW9yaXR5KHRhc2s6IFRhc2ssIG5ld1ByaW9yaXR5OiBzdHJpbmcpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCB0aGlzLmFwcC52YXVsdC5yZWFkKHRhc2suZmlsZSk7XG4gICAgICAgICAgICBjb25zdCBmcm9udG1hdHRlclJlZ2V4ID0gL14tLS1cXG4oW1xcc1xcU10qPylcXG4tLS0vO1xuICAgICAgICAgICAgY29uc3QgbWF0Y2ggPSBjb250ZW50Lm1hdGNoKGZyb250bWF0dGVyUmVnZXgpO1xuXG4gICAgICAgICAgICBpZiAobWF0Y2gpIHtcbiAgICAgICAgICAgICAgICBsZXQgbmV3RnJvbnRtYXR0ZXIgPSBtYXRjaFsxXTtcbiAgICAgICAgICAgICAgICBuZXdGcm9udG1hdHRlciA9IG5ld0Zyb250bWF0dGVyLnJlcGxhY2UoXG4gICAgICAgICAgICAgICAgICAgIC9wcmlvcml0eTpcXHMqXFx3Ky8sXG4gICAgICAgICAgICAgICAgICAgIGBwcmlvcml0eTogJHtuZXdQcmlvcml0eX1gXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICBpZiAoIW5ld0Zyb250bWF0dGVyLmluY2x1ZGVzKCdwcmlvcml0eTonKSkge1xuICAgICAgICAgICAgICAgICAgICBuZXdGcm9udG1hdHRlciA9IG5ld0Zyb250bWF0dGVyLnJlcGxhY2UoXG4gICAgICAgICAgICAgICAgICAgICAgICAvKHN0YXR1czpbXlxcbl0qKS8sXG4gICAgICAgICAgICAgICAgICAgICAgICBgJDFcXG5wcmlvcml0eTogJHtuZXdQcmlvcml0eX1gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29uc3QgbmV3Q29udGVudCA9IGNvbnRlbnQucmVwbGFjZShmcm9udG1hdHRlclJlZ2V4LCBgLS0tXFxuJHtuZXdGcm9udG1hdHRlcn1cXG4tLS1gKTtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5tb2RpZnkodGFzay5maWxlLCBuZXdDb250ZW50KTtcbiAgICAgICAgICAgICAgICB0YXNrLnByaW9yaXR5ID0gbmV3UHJpb3JpdHkgYXMgJ2hpZ2gnIHwgJ21lZGl1bScgfCAnbG93JztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIHVwZGF0aW5nIHRhc2sgcHJpb3JpdHk6JywgZXJyb3IpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gT3JnYW5pemUgYWxsIHRhc2tzIGJ5IHRhZyAtIG1vdmVzIGZpbGVzIGludG8gc3ViZm9sZGVycyBuYW1lZCBhZnRlciB0aGVpciB0YWdzXG4gICAgYXN5bmMgb3JnYW5pemVUYXNrc0J5VGFnKCkge1xuICAgICAgICBjb25zdCB0YXNrcyA9IGF3YWl0IHRoaXMuc2NhblRhc2tzKCk7XG4gICAgICAgIGNvbnN0IHRhc2tzQnlUYWcgPSBuZXcgTWFwPHN0cmluZywgVGFza1tdPigpO1xuXG4gICAgICAgIC8vIEdyb3VwIHRhc2tzIGJ5IHRhZ1xuICAgICAgICBmb3IgKGNvbnN0IHRhc2sgb2YgdGFza3MpIHtcbiAgICAgICAgICAgIGNvbnN0IHRhZyA9IHRhc2sudGFnIHx8ICd1bnRhZ2dlZCc7XG4gICAgICAgICAgICBpZiAoIXRhc2tzQnlUYWcuaGFzKHRhZykpIHtcbiAgICAgICAgICAgICAgICB0YXNrc0J5VGFnLnNldCh0YWcsIFtdKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRhc2tzQnlUYWcuZ2V0KHRhZykhLnB1c2godGFzayk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbW92ZWRDb3VudCA9IDA7XG4gICAgICAgIGNvbnN0IHZhdWx0ID0gdGhpcy5hcHAudmF1bHQ7XG5cbiAgICAgICAgLy8gUHJvY2VzcyBlYWNoIHRhZyBncm91cFxuICAgICAgICBmb3IgKGNvbnN0IFt0YWcsIHRhZ1Rhc2tzXSBvZiB0YXNrc0J5VGFnKSB7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IHRhc2sgb2YgdGFnVGFza3MpIHtcbiAgICAgICAgICAgICAgICAvLyBTa2lwIGlmIGFscmVhZHkgaW4gY29ycmVjdCBmb2xkZXJcbiAgICAgICAgICAgICAgICBjb25zdCBjdXJyZW50Rm9sZGVyID0gdGFzay5maWxlLnBhcmVudD8ubmFtZTtcbiAgICAgICAgICAgICAgICBpZiAoY3VycmVudEZvbGRlciA9PT0gdGFnKSBjb250aW51ZTtcblxuICAgICAgICAgICAgICAgIC8vIERldGVybWluZSBkZXN0aW5hdGlvbiBmb2xkZXJcbiAgICAgICAgICAgICAgICBjb25zdCBiYXNlRm9sZGVyID0gdGhpcy5maW5kQmFzZVRhc2tGb2xkZXIodGFzay5maWxlKTtcbiAgICAgICAgICAgICAgICBpZiAoIWJhc2VGb2xkZXIpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgICAgICAgY29uc3QgdGFyZ2V0Rm9sZGVyUGF0aCA9IGAke2Jhc2VGb2xkZXIucGF0aH0vJHt0YWd9YDtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICAvLyBDcmVhdGUgdGFyZ2V0IGZvbGRlciBpZiBpdCBkb2Vzbid0IGV4aXN0XG4gICAgICAgICAgICAgICAgICAgIGxldCB0YXJnZXRGb2xkZXIgPSB2YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgodGFyZ2V0Rm9sZGVyUGF0aCk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghdGFyZ2V0Rm9sZGVyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhd2FpdCB2YXVsdC5jcmVhdGVGb2xkZXIodGFyZ2V0Rm9sZGVyUGF0aCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB0YXJnZXRGb2xkZXIgPSB2YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgodGFyZ2V0Rm9sZGVyUGF0aCk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAodGFyZ2V0Rm9sZGVyIGluc3RhbmNlb2YgVEZvbGRlcikge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgbmV3UGF0aCA9IGAke3RhcmdldEZvbGRlclBhdGh9LyR7dGFzay5maWxlLm5hbWV9YDtcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IHZhdWx0LnJlbmFtZSh0YXNrLmZpbGUsIG5ld1BhdGgpO1xuICAgICAgICAgICAgICAgICAgICAgICAgbW92ZWRDb3VudCsrO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5lcnJvcihgRXJyb3IgbW92aW5nIHRhc2sgJHt0YXNrLmZpbGUucGF0aH06YCwgZXJyb3IpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIG5ldyBOb3RpY2UoYE9yZ2FuaXplZCAke21vdmVkQ291bnR9IHRhc2tzIGJ5IHRhZ2ApO1xuICAgICAgICB0aGlzLnJlZnJlc2hWaWV3KCk7XG4gICAgfVxuXG4gICAgLy8gT3JnYW5pemUgdGFza3MgaW4gYSBzcGVjaWZpYyBmb2xkZXIgYnkgdGFnXG4gICAgYXN5bmMgb3JnYW5pemVUYXNrc0luRm9sZGVyKGZvbGRlcjogVEZvbGRlcikge1xuICAgICAgICBjb25zdCBmaWxlcyA9IHRoaXMuY29sbGVjdE1hcmtkb3duRmlsZXMoZm9sZGVyKTtcbiAgICAgICAgbGV0IG1vdmVkQ291bnQgPSAwO1xuICAgICAgICBjb25zdCB2YXVsdCA9IHRoaXMuYXBwLnZhdWx0O1xuXG4gICAgICAgIGZvciAoY29uc3QgZmlsZSBvZiBmaWxlcykge1xuICAgICAgICAgICAgY29uc3QgY2FjaGUgPSB0aGlzLmFwcC5tZXRhZGF0YUNhY2hlLmdldEZpbGVDYWNoZShmaWxlKTtcbiAgICAgICAgICAgIGNvbnN0IHRhZyA9IGNhY2hlPy5mcm9udG1hdHRlcj8udGFnIHx8ICd1bnRhZ2dlZCc7XG5cbiAgICAgICAgICAgIC8vIFNraXAgaWYgYWxyZWFkeSBpbiBjb3JyZWN0IGZvbGRlclxuICAgICAgICAgICAgY29uc3QgY3VycmVudEZvbGRlciA9IGZpbGUucGFyZW50Py5uYW1lO1xuICAgICAgICAgICAgaWYgKGN1cnJlbnRGb2xkZXIgPT09IHRhZykgY29udGludWU7XG5cbiAgICAgICAgICAgIGNvbnN0IHRhcmdldEZvbGRlclBhdGggPSBgJHtmb2xkZXIucGF0aH0vJHt0YWd9YDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAvLyBDcmVhdGUgdGFyZ2V0IGZvbGRlciBpZiBpdCBkb2Vzbid0IGV4aXN0XG4gICAgICAgICAgICAgICAgbGV0IHRhcmdldEZvbGRlciA9IHZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aCh0YXJnZXRGb2xkZXJQYXRoKTtcbiAgICAgICAgICAgICAgICBpZiAoIXRhcmdldEZvbGRlcikge1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCB2YXVsdC5jcmVhdGVGb2xkZXIodGFyZ2V0Rm9sZGVyUGF0aCk7XG4gICAgICAgICAgICAgICAgICAgIHRhcmdldEZvbGRlciA9IHZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aCh0YXJnZXRGb2xkZXJQYXRoKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAodGFyZ2V0Rm9sZGVyIGluc3RhbmNlb2YgVEZvbGRlcikge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBuZXdQYXRoID0gYCR7dGFyZ2V0Rm9sZGVyUGF0aH0vJHtmaWxlLm5hbWV9YDtcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgdmF1bHQucmVuYW1lKGZpbGUsIG5ld1BhdGgpO1xuICAgICAgICAgICAgICAgICAgICBtb3ZlZENvdW50Kys7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmVycm9yKGBFcnJvciBtb3ZpbmcgdGFzayAke2ZpbGUucGF0aH06YCwgZXJyb3IpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbmV3IE5vdGljZShgT3JnYW5pemVkICR7bW92ZWRDb3VudH0gdGFza3MgaW4gJHtmb2xkZXIubmFtZX0gYnkgdGFnYCk7XG4gICAgICAgIHRoaXMucmVmcmVzaFZpZXcoKTtcbiAgICB9XG5cbiAgICAvLyBGaW5kIHRoZSBiYXNlIHRhc2sgZm9sZGVyIGZvciBhIGZpbGVcbiAgICBwcml2YXRlIGZpbmRCYXNlVGFza0ZvbGRlcihmaWxlOiBURmlsZSk6IFRGb2xkZXIgfCBudWxsIHtcbiAgICAgICAgbGV0IGN1cnJlbnQgPSBmaWxlLnBhcmVudDtcbiAgICAgICAgXG4gICAgICAgIHdoaWxlIChjdXJyZW50KSB7XG4gICAgICAgICAgICBpZiAodGhpcy5zZXR0aW5ncy50YXNrRm9sZGVycy5zb21lKHRmID0+IFxuICAgICAgICAgICAgICAgIGN1cnJlbnQhLnBhdGggPT09IHRmIHx8IFxuICAgICAgICAgICAgICAgIGN1cnJlbnQhLnBhdGguZW5kc1dpdGgoJy8nICsgdGYpIHx8XG4gICAgICAgICAgICAgICAgY3VycmVudCEubmFtZSA9PT0gdGZcbiAgICAgICAgICAgICkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gY3VycmVudDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGN1cnJlbnQgPSBjdXJyZW50LnBhcmVudDtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxufVxuXG4vLyBUYXNrIEJvYXJkIFZpZXdcbmNsYXNzIFRhc2tCb2FyZFZpZXcgZXh0ZW5kcyBJdGVtVmlldyB7XG4gICAgcGx1Z2luOiBUYXNrQm9hcmRQbHVnaW47XG4gICAgdGFza3M6IFRhc2tbXSA9IFtdO1xuICAgIGNvbnRhaW5lckVsOiBIVE1MRWxlbWVudDtcbiAgICBzb3J0U2VsZWN0OiBEcm9wZG93bkNvbXBvbmVudDtcbiAgICBzZWxlY3RlZFRhZ3M6IFNldDxzdHJpbmc+ID0gbmV3IFNldCgpO1xuICAgIHRhZ0ZpbHRlckNvbnRhaW5lcjogSFRNTEVsZW1lbnQgfCBudWxsID0gbnVsbDtcblxuICAgIGNvbnN0cnVjdG9yKGxlYWY6IFdvcmtzcGFjZUxlYWYsIHBsdWdpbjogVGFza0JvYXJkUGx1Z2luKSB7XG4gICAgICAgIHN1cGVyKGxlYWYpO1xuICAgICAgICB0aGlzLnBsdWdpbiA9IHBsdWdpbjtcbiAgICB9XG5cbiAgICBnZXRWaWV3VHlwZSgpOiBzdHJpbmcge1xuICAgICAgICByZXR1cm4gVklFV19UWVBFX1RBU0tfQk9BUkQ7XG4gICAgfVxuXG4gICAgZ2V0RGlzcGxheVRleHQoKTogc3RyaW5nIHtcbiAgICAgICAgcmV0dXJuICdUYXNrIEJvYXJkJztcbiAgICB9XG5cbiAgICBnZXRJY29uKCk6IHN0cmluZyB7XG4gICAgICAgIHJldHVybiAnbGF5b3V0LWJvYXJkJztcbiAgICB9XG5cbiAgICBhc3luYyBvbk9wZW4oKSB7XG4gICAgICAgIHRoaXMuY29udGFpbmVyRWwgPSB0aGlzLmNvbnRlbnRFbC5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLWJvYXJkLWNvbnRhaW5lcicgfSk7XG4gICAgICAgIGF3YWl0IHRoaXMucmVmcmVzaCgpO1xuICAgIH1cblxuICAgIGFzeW5jIHJlZnJlc2goKSB7XG4gICAgICAgIHRoaXMudGFza3MgPSBhd2FpdCB0aGlzLnBsdWdpbi5zY2FuVGFza3MoKTtcbiAgICAgICAgdGhpcy5yZW5kZXIoKTtcbiAgICB9XG5cbiAgICByZW5kZXIoKSB7XG4gICAgICAgIHRoaXMuY29udGFpbmVyRWwuZW1wdHkoKTtcblxuICAgICAgICAvLyBIZWFkZXIgd2l0aCBjb250cm9sc1xuICAgICAgICB0aGlzLnJlbmRlckhlYWRlcigpO1xuXG4gICAgICAgIC8vIFRhZyBmaWx0ZXJcbiAgICAgICAgdGhpcy5yZW5kZXJUYWdGaWx0ZXIoKTtcblxuICAgICAgICAvLyBCb2FyZFxuICAgICAgICB0aGlzLnJlbmRlckJvYXJkKCk7XG4gICAgfVxuXG4gICAgcmVuZGVySGVhZGVyKCkge1xuICAgICAgICBjb25zdCBoZWFkZXIgPSB0aGlzLmNvbnRhaW5lckVsLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stYm9hcmQtaGVhZGVyJyB9KTtcblxuICAgICAgICAvLyBUaXRsZVxuICAgICAgICBoZWFkZXIuY3JlYXRlRWwoJ2gyJywgeyB0ZXh0OiAnVGFzayBCb2FyZCcsIGNsczogJ3Rhc2stYm9hcmQtdGl0bGUnIH0pO1xuXG4gICAgICAgIC8vIENvbnRyb2xzXG4gICAgICAgIGNvbnN0IGNvbnRyb2xzID0gaGVhZGVyLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stYm9hcmQtY29udHJvbHMnIH0pO1xuXG4gICAgICAgIC8vIFNvcnQgZHJvcGRvd25cbiAgICAgICAgY29udHJvbHMuY3JlYXRlU3Bhbih7IHRleHQ6ICdTb3J0IGJ5OiAnLCBjbHM6ICd0YXNrLWJvYXJkLWxhYmVsJyB9KTtcbiAgICAgICAgY29uc3Qgc29ydFNlbGVjdCA9IG5ldyBEcm9wZG93bkNvbXBvbmVudChjb250cm9scyk7XG4gICAgICAgIHNvcnRTZWxlY3QuYWRkT3B0aW9uKCdwcmlvcml0eScsICdQcmlvcml0eScpO1xuICAgICAgICBzb3J0U2VsZWN0LmFkZE9wdGlvbigndGFnJywgJ1RhZycpO1xuICAgICAgICBzb3J0U2VsZWN0LmFkZE9wdGlvbigndGl0bGUnLCAnVGl0bGUnKTtcbiAgICAgICAgc29ydFNlbGVjdC5hZGRPcHRpb24oJ2ZvbGRlcicsICdGb2xkZXInKTtcbiAgICAgICAgc29ydFNlbGVjdC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5zb3J0QnkpO1xuICAgICAgICBzb3J0U2VsZWN0Lm9uQ2hhbmdlKCh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3Muc29ydEJ5ID0gdmFsdWUgYXMgYW55O1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgICB0aGlzLnJlbmRlckJvYXJkKCk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIFNvcnQgZGlyZWN0aW9uXG4gICAgICAgIGNvbnN0IGRpckJ0biA9IGNvbnRyb2xzLmNyZWF0ZUVsKCdidXR0b24nLCB7XG4gICAgICAgICAgICBjbHM6ICd0YXNrLWJvYXJkLXNvcnQtZGlyJyxcbiAgICAgICAgICAgIHRleHQ6IHRoaXMucGx1Z2luLnNldHRpbmdzLnNvcnREaXJlY3Rpb24gPT09ICdhc2MnID8gJ+KGkScgOiAn4oaTJ1xuICAgICAgICB9KTtcbiAgICAgICAgZGlyQnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3Muc29ydERpcmVjdGlvbiA9IFxuICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLnNvcnREaXJlY3Rpb24gPT09ICdhc2MnID8gJ2Rlc2MnIDogJ2FzYyc7XG4gICAgICAgICAgICBkaXJCdG4udGV4dENvbnRlbnQgPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zb3J0RGlyZWN0aW9uID09PSAnYXNjJyA/ICfihpEnIDogJ+KGkyc7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyQm9hcmQoKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gT3JnYW5pemUgYnkgdGFnIGJ1dHRvblxuICAgICAgICBjb25zdCBvcmdhbml6ZUJ0biA9IGNvbnRyb2xzLmNyZWF0ZUVsKCdidXR0b24nLCB7XG4gICAgICAgICAgICBjbHM6ICd0YXNrLWJvYXJkLW9yZ2FuaXplJyxcbiAgICAgICAgICAgIHRleHQ6ICfwn5OBIE9yZ2FuaXplJ1xuICAgICAgICB9KTtcbiAgICAgICAgb3JnYW5pemVCdG4udGl0bGUgPSAnT3JnYW5pemUgdGFza3MgYnkgdGFnJztcbiAgICAgICAgb3JnYW5pemVCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5vcmdhbml6ZVRhc2tzQnlUYWcoKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gUmVmcmVzaCBidXR0b25cbiAgICAgICAgY29uc3QgcmVmcmVzaEJ0biA9IGNvbnRyb2xzLmNyZWF0ZUVsKCdidXR0b24nLCB7XG4gICAgICAgICAgICBjbHM6ICd0YXNrLWJvYXJkLXJlZnJlc2gnLFxuICAgICAgICAgICAgdGV4dDogJ/CflIQnXG4gICAgICAgIH0pO1xuICAgICAgICByZWZyZXNoQnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdGhpcy5yZWZyZXNoKCkpO1xuXG4gICAgICAgIC8vIENsZWFyIGZpbHRlcnMgYnV0dG9uIChoaWRkZW4gYnkgZGVmYXVsdClcbiAgICAgICAgY29uc3QgY2xlYXJCdG4gPSBjb250cm9scy5jcmVhdGVFbCgnYnV0dG9uJywge1xuICAgICAgICAgICAgY2xzOiAndGFzay1ib2FyZC1jbGVhci1maWx0ZXJzJyxcbiAgICAgICAgICAgIHRleHQ6ICfinJUgQ2xlYXInXG4gICAgICAgIH0pO1xuICAgICAgICBjbGVhckJ0bi5zdHlsZS5kaXNwbGF5ID0gdGhpcy5zZWxlY3RlZFRhZ3Muc2l6ZSA+IDAgPyAnaW5saW5lLWJsb2NrJyA6ICdub25lJztcbiAgICAgICAgY2xlYXJCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnNlbGVjdGVkVGFncy5jbGVhcigpO1xuICAgICAgICAgICAgdGhpcy5yZW5kZXJUYWdGaWx0ZXIoKTtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyQm9hcmQoKTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gR2V0IGFsbCB1bmlxdWUgdGFncyBmcm9tIHRhc2tzXG4gICAgZ2V0QWxsVGFncygpOiBzdHJpbmdbXSB7XG4gICAgICAgIGNvbnN0IHRhZ3MgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICAgICAgZm9yIChjb25zdCB0YXNrIG9mIHRoaXMudGFza3MpIHtcbiAgICAgICAgICAgIGlmICh0YXNrLnRhZykge1xuICAgICAgICAgICAgICAgIHRhZ3MuYWRkKHRhc2sudGFnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gQXJyYXkuZnJvbSh0YWdzKS5zb3J0KCk7XG4gICAgfVxuXG4gICAgLy8gUmVuZGVyIHRhZyBmaWx0ZXIgY2hlY2tib3hlc1xuICAgIHJlbmRlclRhZ0ZpbHRlcigpIHtcbiAgICAgICAgLy8gUmVtb3ZlIGV4aXN0aW5nIGZpbHRlciBpZiBhbnlcbiAgICAgICAgaWYgKHRoaXMudGFnRmlsdGVyQ29udGFpbmVyKSB7XG4gICAgICAgICAgICB0aGlzLnRhZ0ZpbHRlckNvbnRhaW5lci5yZW1vdmUoKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHRhZ3MgPSB0aGlzLmdldEFsbFRhZ3MoKTtcbiAgICAgICAgaWYgKHRhZ3MubGVuZ3RoID09PSAwKSByZXR1cm47XG5cbiAgICAgICAgdGhpcy50YWdGaWx0ZXJDb250YWluZXIgPSB0aGlzLmNvbnRhaW5lckVsLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stdGFnLWZpbHRlcicgfSk7XG4gICAgICAgIFxuICAgICAgICBjb25zdCBmaWx0ZXJIZWFkZXIgPSB0aGlzLnRhZ0ZpbHRlckNvbnRhaW5lci5jcmVhdGVEaXYoeyBjbHM6ICd0YWctZmlsdGVyLWhlYWRlcicgfSk7XG4gICAgICAgIGZpbHRlckhlYWRlci5jcmVhdGVTcGFuKHsgdGV4dDogJ0ZpbHRlciBieSB0YWc6JywgY2xzOiAndGFnLWZpbHRlci1sYWJlbCcgfSk7XG5cbiAgICAgICAgLy8gU2VsZWN0IGFsbCAvIERlc2VsZWN0IGFsbCBidXR0b25zXG4gICAgICAgIGNvbnN0IGJ0bkdyb3VwID0gZmlsdGVySGVhZGVyLmNyZWF0ZURpdih7IGNsczogJ3RhZy1maWx0ZXItYnV0dG9ucycgfSk7XG4gICAgICAgIFxuICAgICAgICBjb25zdCBzZWxlY3RBbGxCdG4gPSBidG5Hcm91cC5jcmVhdGVFbCgnYnV0dG9uJywge1xuICAgICAgICAgICAgdGV4dDogJ0FsbCcsXG4gICAgICAgICAgICBjbHM6ICd0YWctZmlsdGVyLWJ0bidcbiAgICAgICAgfSk7XG4gICAgICAgIHNlbGVjdEFsbEJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgICAgIHRhZ3MuZm9yRWFjaCh0YWcgPT4gdGhpcy5zZWxlY3RlZFRhZ3MuYWRkKHRhZykpO1xuICAgICAgICAgICAgdGhpcy5yZW5kZXJUYWdGaWx0ZXIoKTtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyQm9hcmQoKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgY29uc3QgZGVzZWxlY3RBbGxCdG4gPSBidG5Hcm91cC5jcmVhdGVFbCgnYnV0dG9uJywge1xuICAgICAgICAgICAgdGV4dDogJ05vbmUnLFxuICAgICAgICAgICAgY2xzOiAndGFnLWZpbHRlci1idG4nXG4gICAgICAgIH0pO1xuICAgICAgICBkZXNlbGVjdEFsbEJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgICAgIHRoaXMuc2VsZWN0ZWRUYWdzLmNsZWFyKCk7XG4gICAgICAgICAgICB0aGlzLnJlbmRlclRhZ0ZpbHRlcigpO1xuICAgICAgICAgICAgdGhpcy5yZW5kZXJCb2FyZCgpO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBDaGVja2JveCBjb250YWluZXJcbiAgICAgICAgY29uc3QgY2hlY2tib3hDb250YWluZXIgPSB0aGlzLnRhZ0ZpbHRlckNvbnRhaW5lci5jcmVhdGVEaXYoeyBjbHM6ICd0YWctY2hlY2tib3gtY29udGFpbmVyJyB9KTtcblxuICAgICAgICBmb3IgKGNvbnN0IHRhZyBvZiB0YWdzKSB7XG4gICAgICAgICAgICBjb25zdCBsYWJlbCA9IGNoZWNrYm94Q29udGFpbmVyLmNyZWF0ZUVsKCdsYWJlbCcsIHsgY2xzOiAndGFnLWNoZWNrYm94LWxhYmVsJyB9KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29uc3QgY2hlY2tib3ggPSBsYWJlbC5jcmVhdGVFbCgnaW5wdXQnLCB7XG4gICAgICAgICAgICAgICAgdHlwZTogJ2NoZWNrYm94JyxcbiAgICAgICAgICAgICAgICBjbHM6ICd0YWctY2hlY2tib3gnXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGNoZWNrYm94LmNoZWNrZWQgPSB0aGlzLnNlbGVjdGVkVGFncy5oYXModGFnKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgbGFiZWwuY3JlYXRlU3Bhbih7IHRleHQ6IHRhZywgY2xzOiAndGFnLWNoZWNrYm94LXRleHQnIH0pO1xuXG4gICAgICAgICAgICAvLyBDb3VudCB0YXNrcyB3aXRoIHRoaXMgdGFnXG4gICAgICAgICAgICBjb25zdCBjb3VudCA9IHRoaXMudGFza3MuZmlsdGVyKHQgPT4gdC50YWcgPT09IHRhZykubGVuZ3RoO1xuICAgICAgICAgICAgbGFiZWwuY3JlYXRlU3Bhbih7IHRleHQ6IGAoJHtjb3VudH0pYCwgY2xzOiAndGFnLWNoZWNrYm94LWNvdW50JyB9KTtcblxuICAgICAgICAgICAgY2hlY2tib3guYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChjaGVja2JveC5jaGVja2VkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuc2VsZWN0ZWRUYWdzLmFkZCh0YWcpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuc2VsZWN0ZWRUYWdzLmRlbGV0ZSh0YWcpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB0aGlzLnJlbmRlckJvYXJkKCk7XG4gICAgICAgICAgICAgICAgLy8gVXBkYXRlIGNsZWFyIGJ1dHRvbiB2aXNpYmlsaXR5XG4gICAgICAgICAgICAgICAgY29uc3QgY2xlYXJCdG4gPSB0aGlzLmNvbnRhaW5lckVsLnF1ZXJ5U2VsZWN0b3IoJy50YXNrLWJvYXJkLWNsZWFyLWZpbHRlcnMnKSBhcyBIVE1MRWxlbWVudDtcbiAgICAgICAgICAgICAgICBpZiAoY2xlYXJCdG4pIHtcbiAgICAgICAgICAgICAgICAgICAgY2xlYXJCdG4uc3R5bGUuZGlzcGxheSA9IHRoaXMuc2VsZWN0ZWRUYWdzLnNpemUgPiAwID8gJ2lubGluZS1ibG9jaycgOiAnbm9uZSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZW5kZXJCb2FyZCgpIHtcbiAgICAgICAgLy8gUmVtb3ZlIGV4aXN0aW5nIGJvYXJkIGlmIGFueVxuICAgICAgICBjb25zdCBleGlzdGluZ0JvYXJkID0gdGhpcy5jb250YWluZXJFbC5xdWVyeVNlbGVjdG9yKCcudGFzay1ib2FyZCcpO1xuICAgICAgICBpZiAoZXhpc3RpbmdCb2FyZCkgZXhpc3RpbmdCb2FyZC5yZW1vdmUoKTtcblxuICAgICAgICBjb25zdCBib2FyZCA9IHRoaXMuY29udGFpbmVyRWwuY3JlYXRlRGl2KHsgY2xzOiAndGFzay1ib2FyZCcgfSk7XG5cbiAgICAgICAgLy8gRmlsdGVyIHRhc2tzIGJ5IHNlbGVjdGVkIHRhZ3NcbiAgICAgICAgbGV0IGZpbHRlcmVkVGFza3MgPSB0aGlzLnRhc2tzO1xuICAgICAgICBpZiAodGhpcy5zZWxlY3RlZFRhZ3Muc2l6ZSA+IDApIHtcbiAgICAgICAgICAgIGZpbHRlcmVkVGFza3MgPSB0aGlzLnRhc2tzLmZpbHRlcih0YXNrID0+IHRoaXMuc2VsZWN0ZWRUYWdzLmhhcyh0YXNrLnRhZykpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gR3JvdXAgdGFza3MgYnkgc3RhdHVzXG4gICAgICAgIGNvbnN0IHRhc2tzQnlTdGF0dXMgPSBuZXcgTWFwPHN0cmluZywgVGFza1tdPigpO1xuICAgICAgICBcbiAgICAgICAgLy8gSW5pdGlhbGl6ZSB3aXRoIGNvbmZpZ3VyZWQgc3RhdHVzIG9yZGVyXG4gICAgICAgIGZvciAoY29uc3Qgc3RhdHVzIG9mIHRoaXMucGx1Z2luLnNldHRpbmdzLnN0YXR1c09yZGVyKSB7XG4gICAgICAgICAgICB0YXNrc0J5U3RhdHVzLnNldChzdGF0dXMsIFtdKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEdyb3VwIHRhc2tzXG4gICAgICAgIGZvciAoY29uc3QgdGFzayBvZiBmaWx0ZXJlZFRhc2tzKSB7XG4gICAgICAgICAgICBjb25zdCBzdGF0dXMgPSB0YXNrLnN0YXR1cyB8fCB0aGlzLnBsdWdpbi5zZXR0aW5ncy5kZWZhdWx0U3RhdHVzO1xuICAgICAgICAgICAgaWYgKCF0YXNrc0J5U3RhdHVzLmhhcyhzdGF0dXMpKSB7XG4gICAgICAgICAgICAgICAgdGFza3NCeVN0YXR1cy5zZXQoc3RhdHVzLCBbXSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0YXNrc0J5U3RhdHVzLmdldChzdGF0dXMpIS5wdXNoKHRhc2spO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gU29ydCB0YXNrcyB3aXRoaW4gZWFjaCBjb2x1bW5cbiAgICAgICAgZm9yIChjb25zdCBbc3RhdHVzLCB0YXNrc10gb2YgdGFza3NCeVN0YXR1cykge1xuICAgICAgICAgICAgdGhpcy5zb3J0VGFza3ModGFza3MpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQ3JlYXRlIGNvbHVtbnNcbiAgICAgICAgZm9yIChjb25zdCBzdGF0dXMgb2YgdGhpcy5wbHVnaW4uc2V0dGluZ3Muc3RhdHVzT3JkZXIpIHtcbiAgICAgICAgICAgIGNvbnN0IHRhc2tzID0gdGFza3NCeVN0YXR1cy5nZXQoc3RhdHVzKSB8fCBbXTtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyQ29sdW1uKGJvYXJkLCBzdGF0dXMsIHRhc2tzKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHNvcnRUYXNrcyh0YXNrczogVGFza1tdKSB7XG4gICAgICAgIGNvbnN0IHNvcnRCeSA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnNvcnRCeTtcbiAgICAgICAgY29uc3QgZGlyZWN0aW9uID0gdGhpcy5wbHVnaW4uc2V0dGluZ3Muc29ydERpcmVjdGlvbjtcbiAgICAgICAgY29uc3QgbXVsdGlwbGllciA9IGRpcmVjdGlvbiA9PT0gJ2FzYycgPyAxIDogLTE7XG5cbiAgICAgICAgdGFza3Muc29ydCgoYSwgYikgPT4ge1xuICAgICAgICAgICAgbGV0IGNvbXBhcmlzb24gPSAwO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKHNvcnRCeSkge1xuICAgICAgICAgICAgICAgIGNhc2UgJ3ByaW9yaXR5JzpcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcHJpb3JpdHlNYXAgPSB7IGhpZ2g6IDMsIG1lZGl1bTogMiwgbG93OiAxIH07XG4gICAgICAgICAgICAgICAgICAgIGNvbXBhcmlzb24gPSBwcmlvcml0eU1hcFthLnByaW9yaXR5XSAtIHByaW9yaXR5TWFwW2IucHJpb3JpdHldO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlICd0YWcnOlxuICAgICAgICAgICAgICAgICAgICBjb21wYXJpc29uID0gYS50YWcubG9jYWxlQ29tcGFyZShiLnRhZyk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGNhc2UgJ3RpdGxlJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGFyaXNvbiA9IGEudGl0bGUubG9jYWxlQ29tcGFyZShiLnRpdGxlKTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgY2FzZSAnZm9sZGVyJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGFyaXNvbiA9IGEuZm9sZGVyLmxvY2FsZUNvbXBhcmUoYi5mb2xkZXIpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGNvbXBhcmlzb24gKiBtdWx0aXBsaWVyO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICByZW5kZXJDb2x1bW4oYm9hcmQ6IEhUTUxFbGVtZW50LCBzdGF0dXM6IHN0cmluZywgdGFza3M6IFRhc2tbXSkge1xuICAgICAgICBjb25zdCBjb2x1bW4gPSBib2FyZC5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLWJvYXJkLWNvbHVtbicgfSk7XG4gICAgICAgIGNvbHVtbi5zZXRBdHRyaWJ1dGUoJ2RhdGEtc3RhdHVzJywgc3RhdHVzKTtcblxuICAgICAgICAvLyBDb2x1bW4gaGVhZGVyXG4gICAgICAgIGNvbnN0IGhlYWRlciA9IGNvbHVtbi5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLWNvbHVtbi1oZWFkZXInIH0pO1xuICAgICAgICBjb25zdCBzdGF0dXNMYWJlbCA9IHRoaXMuZ2V0U3RhdHVzTGFiZWwoc3RhdHVzKTtcbiAgICAgICAgaGVhZGVyLmNyZWF0ZUVsKCdoMycsIHsgdGV4dDogc3RhdHVzTGFiZWwsIGNsczogYHRhc2stY29sdW1uLXRpdGxlIHN0YXR1cy0ke3N0YXR1c31gIH0pO1xuICAgICAgICBoZWFkZXIuY3JlYXRlU3Bhbih7IHRleHQ6IGAke3Rhc2tzLmxlbmd0aH1gLCBjbHM6ICd0YXNrLWNvdW50JyB9KTtcblxuICAgICAgICAvLyBUYXNrcyBjb250YWluZXJcbiAgICAgICAgY29uc3QgdGFza3NDb250YWluZXIgPSBjb2x1bW4uY3JlYXRlRGl2KHsgY2xzOiAndGFzay1jb2x1bW4tdGFza3MnIH0pO1xuXG4gICAgICAgIC8vIFJlbmRlciB0YXNrc1xuICAgICAgICBmb3IgKGNvbnN0IHRhc2sgb2YgdGFza3MpIHtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyVGFza0NhcmQodGFza3NDb250YWluZXIsIHRhc2spO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmVuZGVyVGFza0NhcmQoY29udGFpbmVyOiBIVE1MRWxlbWVudCwgdGFzazogVGFzaykge1xuICAgICAgICBjb25zdCBjYXJkID0gY29udGFpbmVyLmNyZWF0ZURpdih7IGNsczogYHRhc2stY2FyZCBwcmlvcml0eS0ke3Rhc2sucHJpb3JpdHl9YCB9KTtcblxuICAgICAgICAvLyBQcmlvcml0eSBpbmRpY2F0b3JcbiAgICAgICAgY29uc3QgcHJpb3JpdHlEb3QgPSBjYXJkLmNyZWF0ZURpdih7IGNsczogYHRhc2stcHJpb3JpdHkgcHJpb3JpdHktJHt0YXNrLnByaW9yaXR5fWAgfSk7XG4gICAgICAgIHByaW9yaXR5RG90LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKGUpID0+IHtcbiAgICAgICAgICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgICAgICAgICB0aGlzLnNob3dQcmlvcml0eU1lbnUodGFzaywgcHJpb3JpdHlEb3QsIGUpO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBUYXNrIHRpdGxlXG4gICAgICAgIGNvbnN0IHRpdGxlID0gY2FyZC5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLXRpdGxlJyB9KTtcbiAgICAgICAgdGl0bGUuY3JlYXRlRWwoJ2EnLCB7XG4gICAgICAgICAgICB0ZXh0OiB0YXNrLnRpdGxlLFxuICAgICAgICAgICAgaHJlZjogJyMnLFxuICAgICAgICAgICAgY2xzOiAndGFzay1saW5rJ1xuICAgICAgICB9KS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIChlKSA9PiB7XG4gICAgICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2Uub3BlbkxpbmtUZXh0KHRhc2suZmlsZS5wYXRoLCAnJyk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIFRhc2sgbWV0YVxuICAgICAgICBjb25zdCBtZXRhID0gY2FyZC5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLW1ldGEnIH0pO1xuXG4gICAgICAgIC8vIFRhZ1xuICAgICAgICBpZiAodGFzay50YWcgJiYgdGFzay50YWcgIT09ICd1bnRhZ2dlZCcpIHtcbiAgICAgICAgICAgIG1ldGEuY3JlYXRlU3Bhbih7IHRleHQ6IHRhc2sudGFnLCBjbHM6ICd0YXNrLXRhZycgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBGb2xkZXJcbiAgICAgICAgbWV0YS5jcmVhdGVTcGFuKHsgdGV4dDogdGFzay5mb2xkZXIsIGNsczogJ3Rhc2stZm9sZGVyJyB9KTtcblxuICAgICAgICAvLyBTdGF0dXMgY2hhbmdlIG9uIGNhcmQgY2xpY2tcbiAgICAgICAgY2FyZC5hZGRFdmVudExpc3RlbmVyKCdjb250ZXh0bWVudScsIChlKSA9PiB7XG4gICAgICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgICAgICB0aGlzLnNob3dTdGF0dXNNZW51KHRhc2ssIGUpO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBEcmFnIHN1cHBvcnRcbiAgICAgICAgY2FyZC5kcmFnZ2FibGUgPSB0cnVlO1xuICAgICAgICBjYXJkLmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdzdGFydCcsIChlKSA9PiB7XG4gICAgICAgICAgICBlLmRhdGFUcmFuc2Zlcj8uc2V0RGF0YSgndGV4dC9wbGFpbicsIHRhc2suaWQpO1xuICAgICAgICAgICAgY2FyZC5jbGFzc0xpc3QuYWRkKCdkcmFnZ2luZycpO1xuICAgICAgICB9KTtcbiAgICAgICAgY2FyZC5hZGRFdmVudExpc3RlbmVyKCdkcmFnZW5kJywgKCkgPT4ge1xuICAgICAgICAgICAgY2FyZC5jbGFzc0xpc3QucmVtb3ZlKCdkcmFnZ2luZycpO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBzaG93UHJpb3JpdHlNZW51KHRhc2s6IFRhc2ssIGVsZW1lbnQ6IEhUTUxFbGVtZW50LCBldnQ6IE1vdXNlRXZlbnQpIHtcbiAgICAgICAgY29uc3QgbWVudSA9IG5ldyBNZW51KCk7XG4gICAgICAgIFxuICAgICAgICBjb25zdCBwcmlvcml0aWVzID0gWydoaWdoJywgJ21lZGl1bScsICdsb3cnXSBhcyBjb25zdDtcbiAgICAgICAgZm9yIChjb25zdCBwcmlvcml0eSBvZiBwcmlvcml0aWVzKSB7XG4gICAgICAgICAgICBtZW51LmFkZEl0ZW0oKGl0ZW0pID0+IHtcbiAgICAgICAgICAgICAgICBpdGVtLnNldFRpdGxlKHByaW9yaXR5LmNoYXJBdCgwKS50b1VwcGVyQ2FzZSgpICsgcHJpb3JpdHkuc2xpY2UoMSkpXG4gICAgICAgICAgICAgICAgICAgIC5zZXRJY29uKHRhc2sucHJpb3JpdHkgPT09IHByaW9yaXR5ID8gJ2NoZWNrJyA6ICcnKVxuICAgICAgICAgICAgICAgICAgICAub25DbGljayhhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi51cGRhdGVUYXNrUHJpb3JpdHkodGFzaywgcHJpb3JpdHkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5yZWZyZXNoKCk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBtZW51LnNob3dBdE1vdXNlRXZlbnQoZXZ0KTtcbiAgICB9XG5cbiAgICBzaG93U3RhdHVzTWVudSh0YXNrOiBUYXNrLCBldnQ6IE1vdXNlRXZlbnQpIHtcbiAgICAgICAgY29uc3QgbWVudSA9IG5ldyBNZW51KCk7XG4gICAgICAgIFxuICAgICAgICBmb3IgKGNvbnN0IHN0YXR1cyBvZiB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zdGF0dXNPcmRlcikge1xuICAgICAgICAgICAgbWVudS5hZGRJdGVtKChpdGVtKSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgbGFiZWwgPSB0aGlzLmdldFN0YXR1c0xhYmVsKHN0YXR1cyk7XG4gICAgICAgICAgICAgICAgaXRlbS5zZXRUaXRsZShsYWJlbClcbiAgICAgICAgICAgICAgICAgICAgLnNldEljb24odGFzay5zdGF0dXMgPT09IHN0YXR1cyA/ICdjaGVjaycgOiAnJylcbiAgICAgICAgICAgICAgICAgICAgLm9uQ2xpY2soYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4udXBkYXRlVGFza1N0YXR1cyh0YXNrLCBzdGF0dXMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5yZWZyZXNoKCk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBtZW51LnNob3dBdE1vdXNlRXZlbnQoZXZ0KTtcbiAgICB9XG5cbiAgICBnZXRTdGF0dXNMYWJlbChzdGF0dXM6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgICAgIGNvbnN0IGxhYmVsczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICAgICAgICAgICd0b2RvJzogJ1RvIERvJyxcbiAgICAgICAgICAgICdpbi1wcm9ncmVzcyc6ICdJbiBQcm9ncmVzcycsXG4gICAgICAgICAgICAnZG9uZSc6ICdEb25lJyxcbiAgICAgICAgICAgICdhcmNoaXZlJzogJ0FyY2hpdmUnXG4gICAgICAgIH07XG4gICAgICAgIHJldHVybiBsYWJlbHNbc3RhdHVzXSB8fCBzdGF0dXMuY2hhckF0KDApLnRvVXBwZXJDYXNlKCkgKyBzdGF0dXMuc2xpY2UoMSk7XG4gICAgfVxufVxuXG4vLyBTZXR0aW5ncyBUYWJcbmNsYXNzIFRhc2tCb2FyZFNldHRpbmdUYWIgZXh0ZW5kcyBQbHVnaW5TZXR0aW5nVGFiIHtcbiAgICBwbHVnaW46IFRhc2tCb2FyZFBsdWdpbjtcblxuICAgIGNvbnN0cnVjdG9yKGFwcDogQXBwLCBwbHVnaW46IFRhc2tCb2FyZFBsdWdpbikge1xuICAgICAgICBzdXBlcihhcHAsIHBsdWdpbik7XG4gICAgICAgIHRoaXMucGx1Z2luID0gcGx1Z2luO1xuICAgIH1cblxuICAgIGRpc3BsYXkoKTogdm9pZCB7XG4gICAgICAgIGNvbnN0IHsgY29udGFpbmVyRWwgfSA9IHRoaXM7XG4gICAgICAgIGNvbnRhaW5lckVsLmVtcHR5KCk7XG5cbiAgICAgICAgY29udGFpbmVyRWwuY3JlYXRlRWwoJ2gyJywgeyB0ZXh0OiAnVGFzayBCb2FyZCBTZXR0aW5ncycgfSk7XG5cbiAgICAgICAgLy8gVGFzayBmb2xkZXJzXG4gICAgICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgICAgICAgLnNldE5hbWUoJ1Rhc2sgZm9sZGVyIG5hbWVzJylcbiAgICAgICAgICAgIC5zZXREZXNjKCdOYW1lcyBvZiBmb2xkZXJzIHRoYXQgY29udGFpbiB0YXNrcyAoY29tbWEtc2VwYXJhdGVkKS4gV2lsbCBzZWFyY2ggaW4gc3ViZm9sZGVycyByZWN1cnNpdmVseS4nKVxuICAgICAgICAgICAgLmFkZFRleHQodGV4dCA9PiB0ZXh0XG4gICAgICAgICAgICAgICAgLnNldFBsYWNlaG9sZGVyKCd0YXNrcywgdG9kbywgaXNzdWVzJylcbiAgICAgICAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MudGFza0ZvbGRlcnMuam9pbignLCAnKSlcbiAgICAgICAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLnRhc2tGb2xkZXJzID0gdmFsdWVcbiAgICAgICAgICAgICAgICAgICAgICAgIC5zcGxpdCgnLCcpXG4gICAgICAgICAgICAgICAgICAgICAgICAubWFwKHMgPT4gcy50cmltKCkpXG4gICAgICAgICAgICAgICAgICAgICAgICAuZmlsdGVyKHMgPT4gcy5sZW5ndGggPiAwKTtcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgICAgICAgfSkpO1xuXG4gICAgICAgIC8vIFN0YXR1cyBvcmRlclxuICAgICAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgICAgICAgIC5zZXROYW1lKCdTdGF0dXMgY29sdW1ucycpXG4gICAgICAgICAgICAuc2V0RGVzYygnT3JkZXIgb2Ygc3RhdHVzIGNvbHVtbnMgKGNvbW1hLXNlcGFyYXRlZCknKVxuICAgICAgICAgICAgLmFkZFRleHQodGV4dCA9PiB0ZXh0XG4gICAgICAgICAgICAgICAgLnNldFBsYWNlaG9sZGVyKCd0b2RvLCBpbi1wcm9ncmVzcywgZG9uZSwgYXJjaGl2ZScpXG4gICAgICAgICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLnN0YXR1c09yZGVyLmpvaW4oJywgJykpXG4gICAgICAgICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zdGF0dXNPcmRlciA9IHZhbHVlXG4gICAgICAgICAgICAgICAgICAgICAgICAuc3BsaXQoJywnKVxuICAgICAgICAgICAgICAgICAgICAgICAgLm1hcChzID0+IHMudHJpbSgpKVxuICAgICAgICAgICAgICAgICAgICAgICAgLmZpbHRlcihzID0+IHMubGVuZ3RoID4gMCk7XG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgICAgIH0pKTtcblxuICAgICAgICAvLyBEZWZhdWx0IHN0YXR1c1xuICAgICAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgICAgICAgIC5zZXROYW1lKCdEZWZhdWx0IHN0YXR1cycpXG4gICAgICAgICAgICAuc2V0RGVzYygnRGVmYXVsdCBzdGF0dXMgZm9yIHRhc2tzIHdpdGhvdXQgZnJvbnRtYXR0ZXInKVxuICAgICAgICAgICAgLmFkZFRleHQodGV4dCA9PiB0ZXh0XG4gICAgICAgICAgICAgICAgLnNldFBsYWNlaG9sZGVyKCd0b2RvJylcbiAgICAgICAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuZGVmYXVsdFN0YXR1cylcbiAgICAgICAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLmRlZmF1bHRTdGF0dXMgPSB2YWx1ZS50cmltKCkgfHwgJ3RvZG8nO1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICAgICAgICB9KSk7XG4gICAgfVxufVxuIl19