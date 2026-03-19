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
    // Update task tag
    async updateTask(task, newTag) {
        try {
            const content = await this.app.vault.read(task.file);
            const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
            const match = content.match(frontmatterRegex);
            if (match) {
                let newFrontmatter = match[1];
                newFrontmatter = newFrontmatter.replace(/tag:\s*\S+/, `tag: ${newTag}`);
                if (!newFrontmatter.includes('tag:')) {
                    newFrontmatter = newFrontmatter.replace(/(status:[^\n]*)/, `$1\ntag: ${newTag}`);
                }
                const newContent = content.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
                await this.app.vault.modify(task.file, newContent);
                task.tag = newTag;
                new obsidian_1.Notice(`Task tag changed to ${newTag}`);
            }
        }
        catch (error) {
            console.error('Error updating task tag:', error);
            new obsidian_1.Notice('Failed to update task tag');
        }
    }
    // Move task to different folder
    async moveTaskToFolder(task, targetFolder) {
        try {
            const newPath = `${targetFolder.path}/${task.file.name}`;
            await this.app.vault.rename(task.file, newPath);
            new obsidian_1.Notice(`Task moved to ${targetFolder.name}`);
        }
        catch (error) {
            console.error('Error moving task:', error);
            new obsidian_1.Notice('Failed to move task');
        }
    }
    // Create a new task
    async createNewTask(title, folderName, tag, priority = 'medium') {
        try {
            // Find the base tasks folder
            const vault = this.app.vault;
            const allFolders = vault.getAllLoadedFiles()
                .filter(f => f instanceof obsidian_1.TFolder);
            let targetFolder = null;
            // Find the tasks folder that contains this folder
            for (const folder of allFolders) {
                if (folder.name === folderName || folder.path.includes(`/${folderName}/`) || folder.path.endsWith(`/${folderName}`)) {
                    // Check if this is a task folder
                    const isTaskFolder = this.settings.taskFolders.some(tf => folder.path === tf ||
                        folder.path.endsWith('/' + tf) ||
                        folder.name === tf);
                    if (isTaskFolder || folder.path.includes('/tasks/')) {
                        targetFolder = folder;
                        break;
                    }
                }
            }
            // Fallback: find any tasks folder
            if (!targetFolder) {
                for (const folder of allFolders) {
                    if (this.settings.taskFolders.some(tf => folder.name === tf || folder.path.endsWith('/' + tf))) {
                        targetFolder = folder;
                        break;
                    }
                }
            }
            if (!targetFolder) {
                new obsidian_1.Notice('Could not find tasks folder');
                return;
            }
            // Create folder for tag if it doesn't exist
            const tagFolderPath = `${targetFolder.path}/${tag}`;
            let tagFolder = vault.getAbstractFileByPath(tagFolderPath);
            if (!tagFolder) {
                await vault.createFolder(tagFolderPath);
                tagFolder = vault.getAbstractFileByPath(tagFolderPath);
            }
            if (!(tagFolder instanceof obsidian_1.TFolder)) {
                new obsidian_1.Notice('Error creating tag folder');
                return;
            }
            // Generate filename from title
            const filename = title.toLowerCase()
                .replace(/[^a-z0-9\s-]/g, '')
                .replace(/\s+/g, '-')
                .substring(0, 50) || 'new-task';
            const filePath = `${tagFolderPath}/${filename}.md`;
            // Check if file exists and append number if needed
            let finalPath = filePath;
            let counter = 1;
            while (vault.getAbstractFileByPath(finalPath)) {
                finalPath = `${tagFolderPath}/${filename}-${counter}.md`;
                counter++;
            }
            // Create task content
            const content = `---
status: todo
tag: ${tag}
priority: ${priority}
---

# ${title}

`;
            await vault.create(finalPath, content);
            new obsidian_1.Notice(`Task created: ${title}`);
            this.refreshView();
            // Open the new file
            const newFile = vault.getAbstractFileByPath(finalPath);
            if (newFile instanceof obsidian_1.TFile) {
                this.app.workspace.openLinkText(newFile.path, '');
            }
        }
        catch (error) {
            console.error('Error creating task:', error);
            new obsidian_1.Notice('Failed to create task');
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
        // Auto-select all tags if none selected (default behavior)
        if (this.selectedTags.size === 0) {
            tags.forEach(tag => this.selectedTags.add(tag));
        }
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
        const allTags = this.getAllTags();
        // Only filter if not all tags are selected
        if (this.selectedTags.size > 0 && this.selectedTags.size < allTags.length) {
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
        // Create columns (skip hidden statuses)
        for (const status of this.plugin.settings.statusOrder) {
            if (this.hiddenStatuses.has(status))
                continue;
            const tasks = tasksByStatus.get(status) || [];
            // For active columns (todo, in-progress), use hierarchical grouping
            if (status === 'todo' || status === 'in-progress') {
                this.renderHierarchicalColumn(board, status, tasks);
            }
            else {
                // Sort and render flat for done/archive columns
                this.sortTasks(tasks);
                this.renderColumn(board, status, tasks);
            }
        }
    }
    // Group tasks by folder, then by tag
    groupTasksHierarchically(tasks) {
        const folderGroups = new Map();
        for (const task of tasks) {
            const folder = task.folder || 'Uncategorized';
            const tag = task.tag || 'untagged';
            if (!folderGroups.has(folder)) {
                folderGroups.set(folder, new Map());
            }
            const tagGroups = folderGroups.get(folder);
            if (!tagGroups.has(tag)) {
                tagGroups.set(tag, []);
            }
            tagGroups.get(tag).push(task);
        }
        // Sort tasks within each tag group
        for (const [folder, tagGroups] of folderGroups) {
            for (const [tag, tagTasks] of tagGroups) {
                this.sortTasks(tagTasks);
            }
        }
        return folderGroups;
    }
    renderHierarchicalColumn(board, status, tasks) {
        const column = board.createDiv({ cls: 'task-board-column hierarchical' });
        column.setAttribute('data-status', status);
        // Group tasks hierarchically
        const folderGroups = this.groupTasksHierarchically(tasks);
        // Calculate dynamic width based on number of tags and folders
        const columnWidth = this.calculateColumnWidth(folderGroups);
        column.style.width = `${columnWidth}px`;
        column.style.minWidth = `${columnWidth}px`;
        column.style.flex = `0 0 ${columnWidth}px`;
        // Column header with drop zone for status change
        const header = column.createDiv({ cls: 'task-column-header' });
        const statusLabel = this.getStatusLabel(status);
        header.createEl('h3', { text: statusLabel, cls: `task-column-title status-${status}` });
        header.createSpan({ text: `${tasks.length}`, cls: 'task-count' });
        // Make entire column a drop zone for status
        this.setupDropZone(column, 'status', status);
        // Tasks container with horizontal layout
        const tasksContainer = column.createDiv({ cls: 'task-column-tasks hierarchical' });
        // Sort folders alphabetically
        const sortedFolders = Array.from(folderGroups.keys()).sort();
        // Render each folder
        for (const folderName of sortedFolders) {
            const tagGroups = folderGroups.get(folderName);
            // Calculate folder section width based on tags
            const folderWidth = this.calculateFolderWidth(tagGroups);
            this.renderFolderSection(tasksContainer, folderName, tagGroups, folderWidth, status);
        }
        // Empty state
        if (tasks.length === 0) {
            tasksContainer.createDiv({ cls: 'task-empty', text: 'No tasks' });
        }
    }
    // Calculate optimal column width based on folder and tag counts
    calculateColumnWidth(folderGroups) {
        const TAG_WIDTH = 200; // Width per tag group (including padding & border)
        const TAG_GAP = 12; // Gap between tags
        const SECTION_PADDING = 48; // Folder section internal padding (16px * 2 + margin)
        const COLUMN_PADDING = 48; // Column content padding (12px * 2 + extra)
        const MIN_WIDTH = 400; // Minimum column width
        let maxFolderWidth = 0;
        // Calculate width for each folder (all tags in one line)
        for (const [folder, tagGroups] of folderGroups) {
            const tagCount = tagGroups.size;
            // Account for tags, gaps between them, and container padding
            const contentWidth = (tagCount * TAG_WIDTH) + ((tagCount - 1) * TAG_GAP);
            const folderWidth = contentWidth + SECTION_PADDING;
            maxFolderWidth = Math.max(maxFolderWidth, folderWidth);
        }
        // Return the width needed for the widest folder plus column padding
        return Math.max(MIN_WIDTH, maxFolderWidth + COLUMN_PADDING);
    }
    // Calculate folder section width - matches column width calculation
    calculateFolderWidth(tagGroups) {
        const TAG_WIDTH = 200;
        const TAG_GAP = 12;
        const PADDING = 48;
        const tagCount = tagGroups.size;
        const contentWidth = (tagCount * TAG_WIDTH) + ((tagCount - 1) * TAG_GAP);
        return contentWidth + PADDING;
    }
    renderFolderSection(container, folderName, tagGroups, width, status) {
        const folderSection = container.createDiv({ cls: 'folder-section' });
        folderSection.setAttribute('data-folder', folderName);
        // Apply calculated width if provided
        if (width && width > 0) {
            folderSection.style.width = `${width}px`;
            folderSection.style.minWidth = `${width}px`;
        }
        // Folder header with drop indicator and + button
        const folderHeader = folderSection.createDiv({ cls: 'folder-header' });
        const folderTitleContainer = folderHeader.createDiv({ cls: 'folder-title-container' });
        folderTitleContainer.createEl('h4', { text: folderName, cls: 'folder-title' });
        // Add "+" button next to folder name
        const addTagBtn = folderTitleContainer.createEl('button', {
            cls: 'add-tag-btn-header',
            text: '+',
            attr: { title: 'Add new tag' }
        });
        addTagBtn.addEventListener('click', () => {
            this.showNewTagDialog(folderName);
        });
        const totalTasks = Array.from(tagGroups.values()).reduce((sum, tasks) => sum + tasks.length, 0);
        folderHeader.createSpan({ text: `${totalTasks}`, cls: 'folder-count' });
        // Horizontal container for tag groups
        const tagsContainer = folderSection.createDiv({ cls: 'tags-container' });
        // Sort tags alphabetically
        const sortedTags = Array.from(tagGroups.keys()).sort();
        // Render each tag group
        for (const tag of sortedTags) {
            const tasks = tagGroups.get(tag);
            this.renderTagGroup(tagsContainer, folderName, tag, tasks);
        }
    }
    renderTagGroup(container, folderName, tag, tasks) {
        const tagGroup = container.createDiv({ cls: 'tag-group' });
        tagGroup.setAttribute('data-tag', tag);
        // Tag header
        const tagHeader = tagGroup.createDiv({ cls: 'tag-header' });
        tagHeader.createSpan({ text: tag, cls: 'tag-group-name' });
        tagHeader.createSpan({ text: `${tasks.length}`, cls: 'tag-group-count' });
        // Tasks in this tag group with drop zone for tag changes
        const tasksContainer = tagGroup.createDiv({ cls: 'tag-tasks' });
        this.setupDropZone(tasksContainer, 'tag', tag);
        for (const task of tasks) {
            this.renderTaskCard(tasksContainer, task);
        }
        // "New" button at the end of tag group
        const newTaskBtn = tagGroup.createEl('button', {
            cls: 'new-task-btn',
            text: 'New'
        });
        newTaskBtn.addEventListener('click', () => {
            this.showNewTaskDialog(folderName, tag);
        });
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
        // Tasks container with drop zone
        const tasksContainer = column.createDiv({ cls: 'task-column-tasks' });
        this.setupDropZone(tasksContainer, 'status', status);
        // Render tasks
        for (const task of tasks) {
            this.renderTaskCard(tasksContainer, task);
        }
    }
    // Setup drop zone for drag and drop
    setupDropZone(element, type, value, folder) {
        element.addEventListener('dragover', (e) => {
            e.preventDefault();
            element.classList.add('drop-target');
        });
        element.addEventListener('dragleave', () => {
            element.classList.remove('drop-target');
        });
        element.addEventListener('drop', async (e) => {
            e.preventDefault();
            element.classList.remove('drop-target');
            const taskId = e.dataTransfer?.getData('text/plain');
            if (!taskId)
                return;
            const task = this.tasks.find(t => t.id === taskId);
            if (!task)
                return;
            // Prevent dropping on same location
            if (type === 'status' && task.status === value)
                return;
            if (type === 'tag' && task.tag === value)
                return;
            if (type === 'folder' && folder && task.file.parent?.path === folder.path)
                return;
            // Perform the move
            if (type === 'status') {
                await this.plugin.updateTaskStatus(task, value);
            }
            else if (type === 'tag') {
                await this.plugin.updateTask(task, value);
            }
            else if (type === 'folder' && folder) {
                await this.plugin.moveTaskToFolder(task, folder);
            }
            this.refresh();
        });
    }
    renderTaskCard(container, task) {
        const card = container.createDiv({ cls: `task-card priority-${task.priority}` });
        card.setAttribute('data-task-id', task.id);
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
            e.dataTransfer?.setData('task/tag', task.tag);
            e.dataTransfer?.setData('task/folder', task.folder);
            card.classList.add('dragging');
        });
        card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
            // Remove all drop-target highlights
            document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
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
    // Show dialog to create a new task in a specific folder and tag
    showNewTaskDialog(folderName, tag) {
        const modal = new NewTaskModal(this.app, folderName, tag, (title, folder, taskTag, priority) => {
            this.plugin.createNewTask(title, folder, taskTag, priority);
        });
        modal.open();
    }
    // Show dialog to create a new tag with a TODO item
    showNewTagDialog(folderName) {
        const modal = new NewTagModal(this.app, folderName, (tagName, title, priority) => {
            this.plugin.createNewTask(title, folderName, tagName, priority);
        });
        modal.open();
    }
}
// Modal for creating a new task
class NewTaskModal extends obsidian_1.Modal {
    constructor(app, folder, tag, onSubmit) {
        super(app);
        this.folder = folder;
        this.tag = tag;
        this.onSubmit = onSubmit;
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Create New Task' });
        // Title input
        contentEl.createEl('label', { text: 'Task Title:' });
        const titleInput = contentEl.createEl('input', {
            type: 'text',
            placeholder: 'Enter task title...'
        });
        titleInput.style.width = '100%';
        titleInput.style.marginBottom = '16px';
        // Folder info
        contentEl.createEl('label', { text: 'Folder:' });
        contentEl.createEl('div', { text: this.folder, cls: 'new-task-info' });
        // Tag info
        contentEl.createEl('label', { text: 'Tag:' });
        contentEl.createEl('div', { text: this.tag, cls: 'new-task-info' });
        // Priority selection
        contentEl.createEl('label', { text: 'Priority:' });
        const prioritySelect = contentEl.createEl('select');
        prioritySelect.style.width = '100%';
        prioritySelect.style.marginBottom = '16px';
        ['high', 'medium', 'low'].forEach(p => {
            const option = prioritySelect.createEl('option', { text: p, value: p });
            if (p === 'medium')
                option.selected = true;
        });
        // Buttons
        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        const submitBtn = buttonContainer.createEl('button', {
            text: 'Create',
            cls: 'mod-cta'
        });
        submitBtn.addEventListener('click', () => {
            const title = titleInput.value.trim();
            if (title) {
                this.onSubmit(title, this.folder, this.tag, prioritySelect.value);
                this.close();
            }
        });
        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());
        // Focus title input
        titleInput.focus();
    }
    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
// Modal for creating a new tag
class NewTagModal extends obsidian_1.Modal {
    constructor(app, folder, onSubmit) {
        super(app);
        this.folder = folder;
        this.onSubmit = onSubmit;
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Create New Tag with Task' });
        // Tag name input
        contentEl.createEl('label', { text: 'Tag Name:' });
        const tagInput = contentEl.createEl('input', {
            type: 'text',
            placeholder: 'Enter new tag name...'
        });
        tagInput.style.width = '100%';
        tagInput.style.marginBottom = '16px';
        // Task title input
        contentEl.createEl('label', { text: 'Task Title:' });
        const titleInput = contentEl.createEl('input', {
            type: 'text',
            placeholder: 'Enter task title...'
        });
        titleInput.style.width = '100%';
        titleInput.style.marginBottom = '16px';
        // Folder info
        contentEl.createEl('label', { text: 'Folder:' });
        contentEl.createEl('div', { text: this.folder, cls: 'new-task-info' });
        // Priority selection
        contentEl.createEl('label', { text: 'Priority:' });
        const prioritySelect = contentEl.createEl('select');
        prioritySelect.style.width = '100%';
        prioritySelect.style.marginBottom = '16px';
        ['high', 'medium', 'low'].forEach(p => {
            const option = prioritySelect.createEl('option', { text: p, value: p });
            if (p === 'medium')
                option.selected = true;
        });
        // Buttons
        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        const submitBtn = buttonContainer.createEl('button', {
            text: 'Create',
            cls: 'mod-cta'
        });
        submitBtn.addEventListener('click', () => {
            const tagName = tagInput.value.trim().toLowerCase().replace(/\s+/g, '-');
            const title = titleInput.value.trim();
            if (tagName && title) {
                this.onSubmit(tagName, title, prioritySelect.value);
                this.close();
            }
        });
        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());
        // Focus tag input
        tagInput.focus();
    }
    onClose() {
        const { contentEl } = this;
        contentEl.empty();
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1haW4udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSx1Q0FpQmtCO0FBeUJsQixNQUFNLGdCQUFnQixHQUFzQjtJQUN4QyxXQUFXLEVBQUUsQ0FBQyxPQUFPLENBQUM7SUFDdEIsV0FBVyxFQUFFLENBQUMsTUFBTSxFQUFFLGFBQWEsRUFBRSxNQUFNLEVBQUUsU0FBUyxDQUFDO0lBQ3ZELGFBQWEsRUFBRSxNQUFNO0lBQ3JCLE1BQU0sRUFBRSxVQUFVO0lBQ2xCLGFBQWEsRUFBRSxNQUFNO0lBQ3JCLGFBQWEsRUFBRSxLQUFLO0lBQ3BCLGNBQWMsRUFBRSxFQUFFO0NBQ3JCLENBQUM7QUFFRixNQUFNLG9CQUFvQixHQUFHLGlCQUFpQixDQUFDO0FBRS9DLG9CQUFvQjtBQUNwQixNQUFxQixlQUFnQixTQUFRLGlCQUFNO0lBRy9DLEtBQUssQ0FBQyxNQUFNO1FBQ1IsTUFBTSxJQUFJLENBQUMsWUFBWSxFQUFFLENBQUM7UUFFMUIsMkJBQTJCO1FBQzNCLElBQUksQ0FBQyxZQUFZLENBQ2Isb0JBQW9CLEVBQ3BCLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxJQUFJLGFBQWEsQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLENBQzFDLENBQUM7UUFFRixrQkFBa0I7UUFDbEIsSUFBSSxDQUFDLGFBQWEsQ0FBQyxjQUFjLEVBQUUsaUJBQWlCLEVBQUUsR0FBRyxFQUFFO1lBQ3ZELElBQUksQ0FBQyxZQUFZLEVBQUUsQ0FBQztRQUN4QixDQUFDLENBQUMsQ0FBQztRQUVILGdDQUFnQztRQUNoQyxJQUFJLENBQUMsVUFBVSxDQUFDO1lBQ1osRUFBRSxFQUFFLGlCQUFpQjtZQUNyQixJQUFJLEVBQUUsaUJBQWlCO1lBQ3ZCLFFBQVEsRUFBRSxHQUFHLEVBQUU7Z0JBQ1gsSUFBSSxDQUFDLFlBQVksRUFBRSxDQUFDO1lBQ3hCLENBQUM7U0FDSixDQUFDLENBQUM7UUFFSCxzQ0FBc0M7UUFDdEMs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ICAgIFBsdWdpblNldHRpbmdUYWIsXG4gICAgU2V0dGluZyxcbiAgICBURmlsZSxcbiAgICBURm9sZGVyLFxuICAgIEl0ZW1WaWV3LFxuICAgIFdvcmtzcGFjZUxlYWYsXG4gICAgTm90aWNlLFxuICAgIE1lbnUsXG4gICAgVGV4dENvbXBvbmVudCxcbiAgICBEcm9wZG93bkNvbXBvbmVudCxcbiAgICBCdXR0b25Db21wb25lbnQsXG4gICAgTWFya2Rvd25SZW5kZXJlcixcbiAgICBDb21wb25lbnQsXG4gICAgTW9kYWxcbn0gZnJvbSAnb2JzaWRpYW4nO1xuXG4vLyBUYXNrIGludGVyZmFjZVxuaW50ZXJmYWNlIFRhc2sge1xuICAgIGlkOiBzdHJpbmc7XG4gICAgZmlsZTogVEZpbGU7XG4gICAgdGl0bGU6IHN0cmluZztcbiAgICBzdGF0dXM6IHN0cmluZztcbiAgICB0YWc6IHN0cmluZztcbiAgICBwcmlvcml0eTogJ2hpZ2gnIHwgJ21lZGl1bScgfCAnbG93JztcbiAgICBjb250ZW50OiBzdHJpbmc7XG4gICAgZm9sZGVyOiBzdHJpbmc7XG59XG5cbi8vIFBsdWdpbiBzZXR0aW5nc1xuaW50ZXJmYWNlIFRhc2tCb2FyZFNldHRpbmdzIHtcbiAgICB0YXNrRm9sZGVyczogc3RyaW5nW107XG4gICAgc3RhdHVzT3JkZXI6IHN0cmluZ1tdO1xuICAgIGRlZmF1bHRTdGF0dXM6IHN0cmluZztcbiAgICBzb3J0Qnk6ICdwcmlvcml0eScgfCAndGFnJyB8ICd0aXRsZScgfCAnZm9sZGVyJztcbiAgICBzb3J0RGlyZWN0aW9uOiAnYXNjJyB8ICdkZXNjJztcbiAgICBvcmdhbml6ZUJ5VGFnOiBib29sZWFuO1xuICAgIGhpZGRlblN0YXR1c2VzOiBzdHJpbmdbXTtcbn1cblxuY29uc3QgREVGQVVMVF9TRVRUSU5HUzogVGFza0JvYXJkU2V0dGluZ3MgPSB7XG4gICAgdGFza0ZvbGRlcnM6IFsndGFza3MnXSxcbiAgICBzdGF0dXNPcmRlcjogWyd0b2RvJywgJ2luLXByb2dyZXNzJywgJ2RvbmUnLCAnYXJjaGl2ZSddLFxuICAgIGRlZmF1bHRTdGF0dXM6ICd0b2RvJyxcbiAgICBzb3J0Qnk6ICdwcmlvcml0eScsXG4gICAgc29ydERpcmVjdGlvbjogJ2Rlc2MnLFxuICAgIG9yZ2FuaXplQnlUYWc6IGZhbHNlLFxuICAgIGhpZGRlblN0YXR1c2VzOiBbXVxufTtcblxuY29uc3QgVklFV19UWVBFX1RBU0tfQk9BUkQgPSAndGFzay1ib2FyZC12aWV3JztcblxuLy8gTWFpbiBQbHVnaW4gQ2xhc3NcbmV4cG9ydCBkZWZhdWx0IGNsYXNzIFRhc2tCb2FyZFBsdWdpbiBleHRlbmRzIFBsdWdpbiB7XG4gICAgc2V0dGluZ3M6IFRhc2tCb2FyZFNldHRpbmdzO1xuXG4gICAgYXN5bmMgb25sb2FkKCkge1xuICAgICAgICBhd2FpdCB0aGlzLmxvYWRTZXR0aW5ncygpO1xuXG4gICAgICAgIC8vIFJlZ2lzdGVyIHRoZSBjdXN0b20gdmlld1xuICAgICAgICB0aGlzLnJlZ2lzdGVyVmlldyhcbiAgICAgICAgICAgIFZJRVdfVFlQRV9UQVNLX0JPQVJELFxuICAgICAgICAgICAgKGxlYWYpID0+IG5ldyBUYXNrQm9hcmRWaWV3KGxlYWYsIHRoaXMpXG4gICAgICAgICk7XG5cbiAgICAgICAgLy8gQWRkIHJpYmJvbiBpY29uXG4gICAgICAgIHRoaXMuYWRkUmliYm9uSWNvbignbGF5b3V0LWJvYXJkJywgJ09wZW4gVGFzayBCb2FyZCcsICgpID0+IHtcbiAgICAgICAgICAgIHRoaXMuYWN0aXZhdGVWaWV3KCk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIEFkZCBjb21tYW5kIC0gT3BlbiBUYXNrIEJvYXJkXG4gICAgICAgIHRoaXMuYWRkQ29tbWFuZCh7XG4gICAgICAgICAgICBpZDogJ29wZW4tdGFzay1ib2FyZCcsXG4gICAgICAgICAgICBuYW1lOiAnT3BlbiBUYXNrIEJvYXJkJyxcbiAgICAgICAgICAgIGNhbGxiYWNrOiAoKSA9PiB7XG4gICAgICAgICAgICAgICAgdGhpcy5hY3RpdmF0ZVZpZXcoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gQWRkIGNvbW1hbmQgLSBPcmdhbml6ZSB0YXNrcyBieSB0YWdcbiAgICAgICAgdGhpcy5hZGRDb21tYW5kKHtcbiAgICAgICAgICAgIGlkOiAnb3JnYW5pemUtdGFza3MtYnktdGFnJyxcbiAgICAgICAgICAgIG5hbWU6ICdPcmdhbml6ZSB0YXNrcyBieSB0YWcnLFxuICAgICAgICAgICAgY2FsbGJhY2s6IGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLm9yZ2FuaXplVGFza3NCeVRhZygpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICAvLyBBZGQgY29tbWFuZCAtIE9yZ2FuaXplIHRhc2tzIGluIGN1cnJlbnQgZm9sZGVyXG4gICAgICAgIHRoaXMuYWRkQ29tbWFuZCh7XG4gICAgICAgICAgICBpZDogJ29yZ2FuaXplLXRhc2tzLWluLWN1cnJlbnQtZm9sZGVyJyxcbiAgICAgICAgICAgIG5hbWU6ICdPcmdhbml6ZSB0YXNrcyBpbiBjdXJyZW50IGZvbGRlciBieSB0YWcnLFxuICAgICAgICAgICAgY2hlY2tDYWxsYmFjazogKGNoZWNraW5nOiBib29sZWFuKSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgZmlsZSA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRBY3RpdmVGaWxlKCk7XG4gICAgICAgICAgICAgICAgaWYgKGZpbGUpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjaGVja2luZykge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZm9sZGVyID0gZmlsZS5wYXJlbnQ7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZm9sZGVyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5vcmdhbml6ZVRhc2tzSW5Gb2xkZXIoZm9sZGVyKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICAvLyBBZGQgc2V0dGluZ3MgdGFiXG4gICAgICAgIHRoaXMuYWRkU2V0dGluZ1RhYihuZXcgVGFza0JvYXJkU2V0dGluZ1RhYih0aGlzLmFwcCwgdGhpcykpO1xuXG4gICAgICAgIC8vIFJlZnJlc2ggdmlldyB3aGVuIGZpbGVzIGNoYW5nZVxuICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQoXG4gICAgICAgICAgICB0aGlzLmFwcC52YXVsdC5vbignY3JlYXRlJywgKCkgPT4gdGhpcy5yZWZyZXNoVmlldygpKVxuICAgICAgICApO1xuICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQoXG4gICAgICAgICAgICB0aGlzLmFwcC52YXVsdC5vbignZGVsZXRlJywgKCkgPT4gdGhpcy5yZWZyZXNoVmlldygpKVxuICAgICAgICApO1xuICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQoXG4gICAgICAgICAgICB0aGlzLmFwcC52YXVsdC5vbigncmVuYW1lJywgKCkgPT4gdGhpcy5yZWZyZXNoVmlldygpKVxuICAgICAgICApO1xuICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQoXG4gICAgICAgICAgICB0aGlzLmFwcC5tZXRhZGF0YUNhY2hlLm9uKCdjaGFuZ2VkJywgKCkgPT4gdGhpcy5yZWZyZXNoVmlldygpKVxuICAgICAgICApO1xuICAgIH1cblxuICAgIG9udW5sb2FkKCkge1xuICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2UuZGV0YWNoTGVhdmVzT2ZUeXBlKFZJRVdfVFlQRV9UQVNLX0JPQVJEKTtcbiAgICB9XG5cbiAgICBhc3luYyBsb2FkU2V0dGluZ3MoKSB7XG4gICAgICAgIHRoaXMuc2V0dGluZ3MgPSBPYmplY3QuYXNzaWduKHt9LCBERUZBVUxUX1NFVFRJTkdTLCBhd2FpdCB0aGlzLmxvYWREYXRhKCkpO1xuICAgIH1cblxuICAgIGFzeW5jIHNhdmVTZXR0aW5ncygpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5zYXZlRGF0YSh0aGlzLnNldHRpbmdzKTtcbiAgICAgICAgdGhpcy5yZWZyZXNoVmlldygpO1xuICAgIH1cblxuICAgIGFzeW5jIGFjdGl2YXRlVmlldygpIHtcbiAgICAgICAgY29uc3QgeyB3b3Jrc3BhY2UgfSA9IHRoaXMuYXBwO1xuXG4gICAgICAgIGxldCBsZWFmOiBXb3Jrc3BhY2VMZWFmIHwgbnVsbCA9IG51bGw7XG4gICAgICAgIGNvbnN0IGxlYXZlcyA9IHdvcmtzcGFjZS5nZXRMZWF2ZXNPZlR5cGUoVklFV19UWVBFX1RBU0tfQk9BUkQpO1xuXG4gICAgICAgIGlmIChsZWF2ZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgbGVhZiA9IGxlYXZlc1swXTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vIENyZWF0ZSBpbiBtYWluIHZpZXcgYXJlYSBpbnN0ZWFkIG9mIHNpZGViYXJcbiAgICAgICAgICAgIGxlYWYgPSB3b3Jrc3BhY2UuZ2V0TGVhZigndGFiJyk7XG4gICAgICAgICAgICBhd2FpdCBsZWFmLnNldFZpZXdTdGF0ZSh7IHR5cGU6IFZJRVdfVFlQRV9UQVNLX0JPQVJELCBhY3RpdmU6IHRydWUgfSk7XG4gICAgICAgIH1cblxuICAgICAgICB3b3Jrc3BhY2UucmV2ZWFsTGVhZihsZWFmKTtcbiAgICB9XG5cbiAgICByZWZyZXNoVmlldygpIHtcbiAgICAgICAgY29uc3QgbGVhdmVzID0gdGhpcy5hcHAud29ya3NwYWNlLmdldExlYXZlc09mVHlwZShWSUVXX1RZUEVfVEFTS19CT0FSRCk7XG4gICAgICAgIGZvciAoY29uc3QgbGVhZiBvZiBsZWF2ZXMpIHtcbiAgICAgICAgICAgIGNvbnN0IHZpZXcgPSBsZWFmLnZpZXcgYXMgVGFza0JvYXJkVmlldztcbiAgICAgICAgICAgIHZpZXcucmVmcmVzaCgpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gUmVjdXJzaXZlbHkgY29sbGVjdCBhbGwgbWFya2Rvd24gZmlsZXMgZnJvbSBhIGZvbGRlciBhbmQgaXRzIHN1YmZvbGRlcnNcbiAgICBwcml2YXRlIGNvbGxlY3RNYXJrZG93bkZpbGVzKGZvbGRlcjogVEZvbGRlcik6IFRGaWxlW10ge1xuICAgICAgICBjb25zdCBmaWxlczogVEZpbGVbXSA9IFtdO1xuICAgICAgICBcbiAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBmb2xkZXIuY2hpbGRyZW4pIHtcbiAgICAgICAgICAgIGlmIChjaGlsZCBpbnN0YW5jZW9mIFRGaWxlICYmIGNoaWxkLmV4dGVuc2lvbiA9PT0gJ21kJykge1xuICAgICAgICAgICAgICAgIGZpbGVzLnB1c2goY2hpbGQpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChjaGlsZCBpbnN0YW5jZW9mIFRGb2xkZXIpIHtcbiAgICAgICAgICAgICAgICAvLyBSZWN1cnNpdmVseSBnZXQgZmlsZXMgZnJvbSBzdWJmb2xkZXJzXG4gICAgICAgICAgICAgICAgZmlsZXMucHVzaCguLi50aGlzLmNvbGxlY3RNYXJrZG93bkZpbGVzKGNoaWxkKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHJldHVybiBmaWxlcztcbiAgICB9XG5cbiAgICAvLyBTY2FuIGFsbCB0YXNrIGZvbGRlcnMgYW5kIHJldHVybiB0YXNrcyAoaW5jbHVkaW5nIHN1YmZvbGRlcnMpXG4gICAgYXN5bmMgc2NhblRhc2tzKCk6IFByb21pc2U8VGFza1tdPiB7XG4gICAgICAgIGNvbnN0IHRhc2tzOiBUYXNrW10gPSBbXTtcbiAgICAgICAgY29uc3QgdmF1bHQgPSB0aGlzLmFwcC52YXVsdDtcblxuICAgICAgICAvLyBHZXQgYWxsIGZvbGRlcnMgaW4gdmF1bHRcbiAgICAgICAgY29uc3QgYWxsRm9sZGVycyA9IHZhdWx0LmdldEFsbExvYWRlZEZpbGVzKClcbiAgICAgICAgICAgIC5maWx0ZXIoZiA9PiBmIGluc3RhbmNlb2YgVEZvbGRlcikgYXMgVEZvbGRlcltdO1xuXG4gICAgICAgIC8vIEZpbmQgdGFzayBmb2xkZXJzIChleGFjdCBtYXRjaGVzIG9yIGZvbGRlcnMgZW5kaW5nIHdpdGggL3Rhc2tzLCBldGMuKVxuICAgICAgICBjb25zdCB0YXNrRm9sZGVyczogVEZvbGRlcltdID0gW107XG4gICAgICAgIGZvciAoY29uc3QgZm9sZGVyIG9mIGFsbEZvbGRlcnMpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLnNldHRpbmdzLnRhc2tGb2xkZXJzLnNvbWUodGYgPT4gXG4gICAgICAgICAgICAgICAgZm9sZGVyLnBhdGggPT09IHRmIHx8IFxuICAgICAgICAgICAgICAgIGZvbGRlci5wYXRoLmVuZHNXaXRoKCcvJyArIHRmKSB8fFxuICAgICAgICAgICAgICAgIGZvbGRlci5uYW1lID09PSB0ZlxuICAgICAgICAgICAgKSkge1xuICAgICAgICAgICAgICAgIHRhc2tGb2xkZXJzLnB1c2goZm9sZGVyKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFNjYW4gZWFjaCB0YXNrIGZvbGRlciByZWN1cnNpdmVseVxuICAgICAgICBmb3IgKGNvbnN0IGZvbGRlciBvZiB0YXNrRm9sZGVycykge1xuICAgICAgICAgICAgLy8gUmVjdXJzaXZlbHkgY29sbGVjdCBhbGwgbWFya2Rvd24gZmlsZXMgaW5jbHVkaW5nIHN1YmZvbGRlcnNcbiAgICAgICAgICAgIGNvbnN0IGZpbGVzID0gdGhpcy5jb2xsZWN0TWFya2Rvd25GaWxlcyhmb2xkZXIpO1xuXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGZpbGUgb2YgZmlsZXMpIHtcbiAgICAgICAgICAgICAgICBjb25zdCB0YXNrID0gYXdhaXQgdGhpcy5wYXJzZVRhc2tGaWxlKGZpbGUsIGZvbGRlcik7XG4gICAgICAgICAgICAgICAgaWYgKHRhc2spIHtcbiAgICAgICAgICAgICAgICAgICAgdGFza3MucHVzaCh0YXNrKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGFza3M7XG4gICAgfVxuXG4gICAgLy8gUGFyc2UgYSB0YXNrIGZpbGUgYW5kIGV4dHJhY3QgbWV0YWRhdGFcbiAgICBhc3luYyBwYXJzZVRhc2tGaWxlKGZpbGU6IFRGaWxlLCBmb2xkZXI6IFRGb2xkZXIpOiBQcm9taXNlPFRhc2sgfCBudWxsPiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBjYWNoZSA9IHRoaXMuYXBwLm1ldGFkYXRhQ2FjaGUuZ2V0RmlsZUNhY2hlKGZpbGUpO1xuICAgICAgICAgICAgY29uc3QgZnJvbnRtYXR0ZXIgPSBjYWNoZT8uZnJvbnRtYXR0ZXI7XG5cbiAgICAgICAgICAgIC8vIFJlYWQgZmlsZSBjb250ZW50IGZvciB0aXRsZSAoZmlyc3QgbGluZSBvciBoMSlcbiAgICAgICAgICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCB0aGlzLmFwcC52YXVsdC5yZWFkKGZpbGUpO1xuICAgICAgICAgICAgbGV0IHRpdGxlID0gZmlsZS5iYXNlbmFtZTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy8gVHJ5IHRvIGZpbmQgYSBiZXR0ZXIgdGl0bGUgZnJvbSBjb250ZW50XG4gICAgICAgICAgICBjb25zdCBsaW5lcyA9IGNvbnRlbnQuc3BsaXQoJ1xcbicpO1xuICAgICAgICAgICAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgdHJpbW1lZCA9IGxpbmUudHJpbSgpO1xuICAgICAgICAgICAgICAgIGlmICh0cmltbWVkICYmICF0cmltbWVkLnN0YXJ0c1dpdGgoJy0tLScpKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICh0cmltbWVkLnN0YXJ0c1dpdGgoJyMgJykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRpdGxlID0gdHJpbW1lZC5zdWJzdHJpbmcoMikudHJpbSgpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gR2V0IHBhcmVudCBmb2xkZXIgbmFtZSBhcyBjYXRlZ29yeVxuICAgICAgICAgICAgY29uc3QgZm9sZGVyUGFydHMgPSBmb2xkZXIucGF0aC5zcGxpdCgnLycpO1xuICAgICAgICAgICAgY29uc3QgcGFyZW50Rm9sZGVyID0gZm9sZGVyUGFydHMubGVuZ3RoID4gMSA/IGZvbGRlclBhcnRzW2ZvbGRlclBhcnRzLmxlbmd0aCAtIDJdIDogJ1Jvb3QnO1xuXG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIGlkOiBmaWxlLnBhdGgsXG4gICAgICAgICAgICAgICAgZmlsZTogZmlsZSxcbiAgICAgICAgICAgICAgICB0aXRsZTogdGl0bGUsXG4gICAgICAgICAgICAgICAgc3RhdHVzOiBmcm9udG1hdHRlcj8uc3RhdHVzIHx8IHRoaXMuc2V0dGluZ3MuZGVmYXVsdFN0YXR1cyxcbiAgICAgICAgICAgICAgICB0YWc6IGZyb250bWF0dGVyPy50YWcgfHwgJ3VudGFnZ2VkJyxcbiAgICAgICAgICAgICAgICBwcmlvcml0eTogKGZyb250bWF0dGVyPy5wcmlvcml0eSB8fCAnbWVkaXVtJykgYXMgJ2hpZ2gnIHwgJ21lZGl1bScgfCAnbG93JyxcbiAgICAgICAgICAgICAgICBjb250ZW50OiBjb250ZW50LFxuICAgICAgICAgICAgICAgIGZvbGRlcjogcGFyZW50Rm9sZGVyXG4gICAgICAgICAgICB9O1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgY29uc29sZS5lcnJvcignRXJyb3IgcGFyc2luZyB0YXNrIGZpbGU6JywgZmlsZS5wYXRoLCBlcnJvcik7XG4gICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIFVwZGF0ZSB0YXNrIHN0YXR1c1xuICAgIGFzeW5jIHVwZGF0ZVRhc2tTdGF0dXModGFzazogVGFzaywgbmV3U3RhdHVzOiBzdHJpbmcpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGNhY2hlID0gdGhpcy5hcHAubWV0YWRhdGFDYWNoZS5nZXRGaWxlQ2FjaGUodGFzay5maWxlKTtcbiAgICAgICAgICAgIGNvbnN0IGZyb250bWF0dGVyID0gY2FjaGU/LmZyb250bWF0dGVyO1xuXG4gICAgICAgICAgICBpZiAoZnJvbnRtYXR0ZXIpIHtcbiAgICAgICAgICAgICAgICAvLyBVcGRhdGUgZnJvbnRtYXR0ZXJcbiAgICAgICAgICAgICAgICBjb25zdCBjb250ZW50ID0gYXdhaXQgdGhpcy5hcHAudmF1bHQucmVhZCh0YXNrLmZpbGUpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGZyb250bWF0dGVyUmVnZXggPSAvXi0tLVxcbihbXFxzXFxTXSo/KVxcbi0tLS87XG4gICAgICAgICAgICAgICAgY29uc3QgbWF0Y2ggPSBjb250ZW50Lm1hdGNoKGZyb250bWF0dGVyUmVnZXgpO1xuXG4gICAgICAgICAgICAgICAgaWYgKG1hdGNoKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBuZXdGcm9udG1hdHRlciA9IG1hdGNoWzFdO1xuICAgICAgICAgICAgICAgICAgICAvLyBSZXBsYWNlIHN0YXR1cyBsaW5lXG4gICAgICAgICAgICAgICAgICAgIG5ld0Zyb250bWF0dGVyID0gbmV3RnJvbnRtYXR0ZXIucmVwbGFjZShcbiAgICAgICAgICAgICAgICAgICAgICAgIC9zdGF0dXM6XFxzKlxcdysvLFxuICAgICAgICAgICAgICAgICAgICAgICAgYHN0YXR1czogJHtuZXdTdGF0dXN9YFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICAvLyBJZiBzdGF0dXMgZG9lc24ndCBleGlzdCwgYWRkIGl0XG4gICAgICAgICAgICAgICAgICAgIGlmICghbmV3RnJvbnRtYXR0ZXIuaW5jbHVkZXMoJ3N0YXR1czonKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbmV3RnJvbnRtYXR0ZXIgPSBgc3RhdHVzOiAke25ld1N0YXR1c31cXG4ke25ld0Zyb250bWF0dGVyfWA7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBjb25zdCBuZXdDb250ZW50ID0gY29udGVudC5yZXBsYWNlKGZyb250bWF0dGVyUmVnZXgsIGAtLS1cXG4ke25ld0Zyb250bWF0dGVyfVxcbi0tLWApO1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5tb2RpZnkodGFzay5maWxlLCBuZXdDb250ZW50KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIEFkZCBmcm9udG1hdHRlciBpZiBpdCBkb2Vzbid0IGV4aXN0XG4gICAgICAgICAgICAgICAgY29uc3QgbmV3RnJvbnRtYXR0ZXIgPSBgLS0tXFxuc3RhdHVzOiAke25ld1N0YXR1c31cXG50YWc6ICR7dGFzay50YWd9XFxucHJpb3JpdHk6ICR7dGFzay5wcmlvcml0eX1cXG4tLS1cXG5cXG5gO1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYXBwLnZhdWx0Lm1vZGlmeSh0YXNrLmZpbGUsIG5ld0Zyb250bWF0dGVyICsgdGFzay5jb250ZW50KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGFzay5zdGF0dXMgPSBuZXdTdGF0dXM7XG4gICAgICAgICAgICBuZXcgTm90aWNlKGBUYXNrIG1vdmVkIHRvICR7bmV3U3RhdHVzfWApO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgY29uc29sZS5lcnJvcignRXJyb3IgdXBkYXRpbmcgdGFzayBzdGF0dXM6JywgZXJyb3IpO1xuICAgICAgICAgICAgbmV3IE5vdGljZSgnRmFpbGVkIHRvIHVwZGF0ZSB0YXNrIHN0YXR1cycpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gVXBkYXRlIHRhc2sgcHJpb3JpdHlcbiAgICBhc3luYyB1cGRhdGVUYXNrUHJpb3JpdHkodGFzazogVGFzaywgbmV3UHJpb3JpdHk6IHN0cmluZykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgY29udGVudCA9IGF3YWl0IHRoaXMuYXBwLnZhdWx0LnJlYWQodGFzay5maWxlKTtcbiAgICAgICAgICAgIGNvbnN0IGZyb250bWF0dGVyUmVnZXggPSAvXi0tLVxcbihbXFxzXFxTXSo/KVxcbi0tLS87XG4gICAgICAgICAgICBjb25zdCBtYXRjaCA9IGNvbnRlbnQubWF0Y2goZnJvbnRtYXR0ZXJSZWdleCk7XG5cbiAgICAgICAgICAgIGlmIChtYXRjaCkge1xuICAgICAgICAgICAgICAgIGxldCBuZXdGcm9udG1hdHRlciA9IG1hdGNoWzFdO1xuICAgICAgICAgICAgICAgIG5ld0Zyb250bWF0dGVyID0gbmV3RnJvbnRtYXR0ZXIucmVwbGFjZShcbiAgICAgICAgICAgICAgICAgICAgL3ByaW9yaXR5OlxccypcXHcrLyxcbiAgICAgICAgICAgICAgICAgICAgYHByaW9yaXR5OiAke25ld1ByaW9yaXR5fWBcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIGlmICghbmV3RnJvbnRtYXR0ZXIuaW5jbHVkZXMoJ3ByaW9yaXR5OicpKSB7XG4gICAgICAgICAgICAgICAgICAgIG5ld0Zyb250bWF0dGVyID0gbmV3RnJvbnRtYXR0ZXIucmVwbGFjZShcbiAgICAgICAgICAgICAgICAgICAgICAgIC8oc3RhdHVzOlteXFxuXSopLyxcbiAgICAgICAgICAgICAgICAgICAgICAgIGAkMVxcbnByaW9yaXR5OiAke25ld1ByaW9yaXR5fWBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdCBuZXdDb250ZW50ID0gY29udGVudC5yZXBsYWNlKGZyb250bWF0dGVyUmVnZXgsIGAtLS1cXG4ke25ld0Zyb250bWF0dGVyfVxcbi0tLWApO1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYXBwLnZhdWx0Lm1vZGlmeSh0YXNrLmZpbGUsIG5ld0NvbnRlbnQpO1xuICAgICAgICAgICAgICAgIHRhc2sucHJpb3JpdHkgPSBuZXdQcmlvcml0eSBhcyAnaGlnaCcgfCAnbWVkaXVtJyB8ICdsb3cnO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgY29uc29sZS5lcnJvcignRXJyb3IgdXBkYXRpbmcgdGFzayBwcmlvcml0eTonLCBlcnJvcik7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBVcGRhdGUgdGFzayB0YWdcbiAgICBhc3luYyB1cGRhdGVUYXNrKHRhc2s6IFRhc2ssIG5ld1RhZzogc3RyaW5nKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBjb250ZW50ID0gYXdhaXQgdGhpcy5hcHAudmF1bHQucmVhZCh0YXNrLmZpbGUpO1xuICAgICAgICAgICAgY29uc3QgZnJvbnRtYXR0ZXJSZWdleCA9IC9eLS0tXFxuKFtcXHNcXFNdKj8pXFxuLS0tLztcbiAgICAgICAgICAgIGNvbnN0IG1hdGNoID0gY29udGVudC5tYXRjaChmcm9udG1hdHRlclJlZ2V4KTtcblxuICAgICAgICAgICAgaWYgKG1hdGNoKSB7XG4gICAgICAgICAgICAgICAgbGV0IG5ld0Zyb250bWF0dGVyID0gbWF0Y2hbMV07XG4gICAgICAgICAgICAgICAgbmV3RnJvbnRtYXR0ZXIgPSBuZXdGcm9udG1hdHRlci5yZXBsYWNlKFxuICAgICAgICAgICAgICAgICAgICAvdGFnOlxccypcXFMrLyxcbiAgICAgICAgICAgICAgICAgICAgYHRhZzogJHtuZXdUYWd9YFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgaWYgKCFuZXdGcm9udG1hdHRlci5pbmNsdWRlcygndGFnOicpKSB7XG4gICAgICAgICAgICAgICAgICAgIG5ld0Zyb250bWF0dGVyID0gbmV3RnJvbnRtYXR0ZXIucmVwbGFjZShcbiAgICAgICAgICAgICAgICAgICAgICAgIC8oc3RhdHVzOlteXFxuXSopLyxcbiAgICAgICAgICAgICAgICAgICAgICAgIGAkMVxcbnRhZzogJHtuZXdUYWd9YFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0IG5ld0NvbnRlbnQgPSBjb250ZW50LnJlcGxhY2UoZnJvbnRtYXR0ZXJSZWdleCwgYC0tLVxcbiR7bmV3RnJvbnRtYXR0ZXJ9XFxuLS0tYCk7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hcHAudmF1bHQubW9kaWZ5KHRhc2suZmlsZSwgbmV3Q29udGVudCk7XG4gICAgICAgICAgICAgICAgdGFzay50YWcgPSBuZXdUYWc7XG4gICAgICAgICAgICAgICAgbmV3IE5vdGljZShgVGFzayB0YWcgY2hhbmdlZCB0byAke25ld1RhZ31gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIHVwZGF0aW5nIHRhc2sgdGFnOicsIGVycm9yKTtcbiAgICAgICAgICAgIG5ldyBOb3RpY2UoJ0ZhaWxlZCB0byB1cGRhdGUgdGFzayB0YWcnKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIE1vdmUgdGFzayB0byBkaWZmZXJlbnQgZm9sZGVyXG4gICAgYXN5bmMgbW92ZVRhc2tUb0ZvbGRlcih0YXNrOiBUYXNrLCB0YXJnZXRGb2xkZXI6IFRGb2xkZXIpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IG5ld1BhdGggPSBgJHt0YXJnZXRGb2xkZXIucGF0aH0vJHt0YXNrLmZpbGUubmFtZX1gO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5hcHAudmF1bHQucmVuYW1lKHRhc2suZmlsZSwgbmV3UGF0aCk7XG4gICAgICAgICAgICBuZXcgTm90aWNlKGBUYXNrIG1vdmVkIHRvICR7dGFyZ2V0Rm9sZGVyLm5hbWV9YCk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKCdFcnJvciBtb3ZpbmcgdGFzazonLCBlcnJvcik7XG4gICAgICAgICAgICBuZXcgTm90aWNlKCdGYWlsZWQgdG8gbW92ZSB0YXNrJyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBDcmVhdGUgYSBuZXcgdGFza1xuICAgIGFzeW5jIGNyZWF0ZU5ld1Rhc2sodGl0bGU6IHN0cmluZywgZm9sZGVyTmFtZTogc3RyaW5nLCB0YWc6IHN0cmluZywgcHJpb3JpdHk6IHN0cmluZyA9ICdtZWRpdW0nKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICAvLyBGaW5kIHRoZSBiYXNlIHRhc2tzIGZvbGRlclxuICAgICAgICAgICAgY29uc3QgdmF1bHQgPSB0aGlzLmFwcC52YXVsdDtcbiAgICAgICAgICAgIGNvbnN0IGFsbEZvbGRlcnMgPSB2YXVsdC5nZXRBbGxMb2FkZWRGaWxlcygpXG4gICAgICAgICAgICAgICAgLmZpbHRlcihmID0+IGYgaW5zdGFuY2VvZiBURm9sZGVyKSBhcyBURm9sZGVyW107XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCB0YXJnZXRGb2xkZXI6IFRGb2xkZXIgfCBudWxsID0gbnVsbDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy8gRmluZCB0aGUgdGFza3MgZm9sZGVyIHRoYXQgY29udGFpbnMgdGhpcyBmb2xkZXJcbiAgICAgICAgICAgIGZvciAoY29uc3QgZm9sZGVyIG9mIGFsbEZvbGRlcnMpIHtcbiAgICAgICAgICAgICAgICBpZiAoZm9sZGVyLm5hbWUgPT09IGZvbGRlck5hbWUgfHwgZm9sZGVyLnBhdGguaW5jbHVkZXMoYC8ke2ZvbGRlck5hbWV9L2ApIHx8IGZvbGRlci5wYXRoLmVuZHNXaXRoKGAvJHtmb2xkZXJOYW1lfWApKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIENoZWNrIGlmIHRoaXMgaXMgYSB0YXNrIGZvbGRlclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBpc1Rhc2tGb2xkZXIgPSB0aGlzLnNldHRpbmdzLnRhc2tGb2xkZXJzLnNvbWUodGYgPT4gXG4gICAgICAgICAgICAgICAgICAgICAgICBmb2xkZXIucGF0aCA9PT0gdGYgfHwgXG4gICAgICAgICAgICAgICAgICAgICAgICBmb2xkZXIucGF0aC5lbmRzV2l0aCgnLycgKyB0ZikgfHxcbiAgICAgICAgICAgICAgICAgICAgICAgIGZvbGRlci5uYW1lID09PSB0ZlxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICBpZiAoaXNUYXNrRm9sZGVyIHx8IGZvbGRlci5wYXRoLmluY2x1ZGVzKCcvdGFza3MvJykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhcmdldEZvbGRlciA9IGZvbGRlcjtcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICAvLyBGYWxsYmFjazogZmluZCBhbnkgdGFza3MgZm9sZGVyXG4gICAgICAgICAgICBpZiAoIXRhcmdldEZvbGRlcikge1xuICAgICAgICAgICAgICAgIGZvciAoY29uc3QgZm9sZGVyIG9mIGFsbEZvbGRlcnMpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuc2V0dGluZ3MudGFza0ZvbGRlcnMuc29tZSh0ZiA9PiBcbiAgICAgICAgICAgICAgICAgICAgICAgIGZvbGRlci5uYW1lID09PSB0ZiB8fCBmb2xkZXIucGF0aC5lbmRzV2l0aCgnLycgKyB0ZilcbiAgICAgICAgICAgICAgICAgICAgKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFyZ2V0Rm9sZGVyID0gZm9sZGVyO1xuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghdGFyZ2V0Rm9sZGVyKSB7XG4gICAgICAgICAgICAgICAgbmV3IE5vdGljZSgnQ291bGQgbm90IGZpbmQgdGFza3MgZm9sZGVyJyk7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBDcmVhdGUgZm9sZGVyIGZvciB0YWcgaWYgaXQgZG9lc24ndCBleGlzdFxuICAgICAgICAgICAgY29uc3QgdGFnRm9sZGVyUGF0aCA9IGAke3RhcmdldEZvbGRlci5wYXRofS8ke3RhZ31gO1xuICAgICAgICAgICAgbGV0IHRhZ0ZvbGRlciA9IHZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aCh0YWdGb2xkZXJQYXRoKTtcbiAgICAgICAgICAgIGlmICghdGFnRm9sZGVyKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdmF1bHQuY3JlYXRlRm9sZGVyKHRhZ0ZvbGRlclBhdGgpO1xuICAgICAgICAgICAgICAgIHRhZ0ZvbGRlciA9IHZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aCh0YWdGb2xkZXJQYXRoKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCEodGFnRm9sZGVyIGluc3RhbmNlb2YgVEZvbGRlcikpIHtcbiAgICAgICAgICAgICAgICBuZXcgTm90aWNlKCdFcnJvciBjcmVhdGluZyB0YWcgZm9sZGVyJyk7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBHZW5lcmF0ZSBmaWxlbmFtZSBmcm9tIHRpdGxlXG4gICAgICAgICAgICBjb25zdCBmaWxlbmFtZSA9IHRpdGxlLnRvTG93ZXJDYXNlKClcbiAgICAgICAgICAgICAgICAucmVwbGFjZSgvW15hLXowLTlcXHMtXS9nLCAnJylcbiAgICAgICAgICAgICAgICAucmVwbGFjZSgvXFxzKy9nLCAnLScpXG4gICAgICAgICAgICAgICAgLnN1YnN0cmluZygwLCA1MCkgfHwgJ25ldy10YXNrJztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29uc3QgZmlsZVBhdGggPSBgJHt0YWdGb2xkZXJQYXRofS8ke2ZpbGVuYW1lfS5tZGA7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIENoZWNrIGlmIGZpbGUgZXhpc3RzIGFuZCBhcHBlbmQgbnVtYmVyIGlmIG5lZWRlZFxuICAgICAgICAgICAgbGV0IGZpbmFsUGF0aCA9IGZpbGVQYXRoO1xuICAgICAgICAgICAgbGV0IGNvdW50ZXIgPSAxO1xuICAgICAgICAgICAgd2hpbGUgKHZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChmaW5hbFBhdGgpKSB7XG4gICAgICAgICAgICAgICAgZmluYWxQYXRoID0gYCR7dGFnRm9sZGVyUGF0aH0vJHtmaWxlbmFtZX0tJHtjb3VudGVyfS5tZGA7XG4gICAgICAgICAgICAgICAgY291bnRlcisrO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBDcmVhdGUgdGFzayBjb250ZW50XG4gICAgICAgICAgICBjb25zdCBjb250ZW50ID0gYC0tLVxuc3RhdHVzOiB0b2RvXG50YWc6ICR7dGFnfVxucHJpb3JpdHk6ICR7cHJpb3JpdHl9XG4tLS1cblxuIyAke3RpdGxlfVxuXG5gO1xuXG4gICAgICAgICAgICBhd2FpdCB2YXVsdC5jcmVhdGUoZmluYWxQYXRoLCBjb250ZW50KTtcbiAgICAgICAgICAgIG5ldyBOb3RpY2UoYFRhc2sgY3JlYXRlZDogJHt0aXRsZX1gKTtcbiAgICAgICAgICAgIHRoaXMucmVmcmVzaFZpZXcoKTtcblxuICAgICAgICAgICAgLy8gT3BlbiB0aGUgbmV3IGZpbGVcbiAgICAgICAgICAgIGNvbnN0IG5ld0ZpbGUgPSB2YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgoZmluYWxQYXRoKTtcbiAgICAgICAgICAgIGlmIChuZXdGaWxlIGluc3RhbmNlb2YgVEZpbGUpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2Uub3BlbkxpbmtUZXh0KG5ld0ZpbGUucGF0aCwgJycpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgY29uc29sZS5lcnJvcignRXJyb3IgY3JlYXRpbmcgdGFzazonLCBlcnJvcik7XG4gICAgICAgICAgICBuZXcgTm90aWNlKCdGYWlsZWQgdG8gY3JlYXRlIHRhc2snKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIE9yZ2FuaXplIGFsbCB0YXNrcyBieSB0YWcgLSBtb3ZlcyBmaWxlcyBpbnRvIHN1YmZvbGRlcnMgbmFtZWQgYWZ0ZXIgdGhlaXIgdGFnc1xuICAgIGFzeW5jIG9yZ2FuaXplVGFza3NCeVRhZygpIHtcbiAgICAgICAgY29uc3QgdGFza3MgPSBhd2FpdCB0aGlzLnNjYW5UYXNrcygpO1xuICAgICAgICBjb25zdCB0YXNrc0J5VGFnID0gbmV3IE1hcDxzdHJpbmcsIFRhc2tbXT4oKTtcblxuICAgICAgICAvLyBHcm91cCB0YXNrcyBieSB0YWdcbiAgICAgICAgZm9yIChjb25zdCB0YXNrIG9mIHRhc2tzKSB7XG4gICAgICAgICAgICBjb25zdCB0YWcgPSB0YXNrLnRhZyB8fCAndW50YWdnZWQnO1xuICAgICAgICAgICAgaWYgKCF0YXNrc0J5VGFnLmhhcyh0YWcpKSB7XG4gICAgICAgICAgICAgICAgdGFza3NCeVRhZy5zZXQodGFnLCBbXSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0YXNrc0J5VGFnLmdldCh0YWcpIS5wdXNoKHRhc2spO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IG1vdmVkQ291bnQgPSAwO1xuICAgICAgICBjb25zdCB2YXVsdCA9IHRoaXMuYXBwLnZhdWx0O1xuXG4gICAgICAgIC8vIFByb2Nlc3MgZWFjaCB0YWcgZ3JvdXBcbiAgICAgICAgZm9yIChjb25zdCBbdGFnLCB0YWdUYXNrc10gb2YgdGFza3NCeVRhZykge1xuICAgICAgICAgICAgZm9yIChjb25zdCB0YXNrIG9mIHRhZ1Rhc2tzKSB7XG4gICAgICAgICAgICAgICAgLy8gU2tpcCBpZiBhbHJlYWR5IGluIGNvcnJlY3QgZm9sZGVyXG4gICAgICAgICAgICAgICAgY29uc3QgY3VycmVudEZvbGRlciA9IHRhc2suZmlsZS5wYXJlbnQ/Lm5hbWU7XG4gICAgICAgICAgICAgICAgaWYgKGN1cnJlbnRGb2xkZXIgPT09IHRhZykgY29udGludWU7XG5cbiAgICAgICAgICAgICAgICAvLyBEZXRlcm1pbmUgZGVzdGluYXRpb24gZm9sZGVyXG4gICAgICAgICAgICAgICAgY29uc3QgYmFzZUZvbGRlciA9IHRoaXMuZmluZEJhc2VUYXNrRm9sZGVyKHRhc2suZmlsZSk7XG4gICAgICAgICAgICAgICAgaWYgKCFiYXNlRm9sZGVyKSBjb250aW51ZTtcblxuICAgICAgICAgICAgICAgIGNvbnN0IHRhcmdldEZvbGRlclBhdGggPSBgJHtiYXNlRm9sZGVyLnBhdGh9LyR7dGFnfWA7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgLy8gQ3JlYXRlIHRhcmdldCBmb2xkZXIgaWYgaXQgZG9lc24ndCBleGlzdFxuICAgICAgICAgICAgICAgICAgICBsZXQgdGFyZ2V0Rm9sZGVyID0gdmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHRhcmdldEZvbGRlclBhdGgpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXRhcmdldEZvbGRlcikge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgdmF1bHQuY3JlYXRlRm9sZGVyKHRhcmdldEZvbGRlclBhdGgpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFyZ2V0Rm9sZGVyID0gdmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHRhcmdldEZvbGRlclBhdGgpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKHRhcmdldEZvbGRlciBpbnN0YW5jZW9mIFRGb2xkZXIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IG5ld1BhdGggPSBgJHt0YXJnZXRGb2xkZXJQYXRofS8ke3Rhc2suZmlsZS5uYW1lfWA7XG4gICAgICAgICAgICAgICAgICAgICAgICBhd2FpdCB2YXVsdC5yZW5hbWUodGFzay5maWxlLCBuZXdQYXRoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIG1vdmVkQ291bnQrKztcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYEVycm9yIG1vdmluZyB0YXNrICR7dGFzay5maWxlLnBhdGh9OmAsIGVycm9yKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBuZXcgTm90aWNlKGBPcmdhbml6ZWQgJHttb3ZlZENvdW50fSB0YXNrcyBieSB0YWdgKTtcbiAgICAgICAgdGhpcy5yZWZyZXNoVmlldygpO1xuICAgIH1cblxuICAgIC8vIE9yZ2FuaXplIHRhc2tzIGluIGEgc3BlY2lmaWMgZm9sZGVyIGJ5IHRhZ1xuICAgIGFzeW5jIG9yZ2FuaXplVGFza3NJbkZvbGRlcihmb2xkZXI6IFRGb2xkZXIpIHtcbiAgICAgICAgY29uc3QgZmlsZXMgPSB0aGlzLmNvbGxlY3RNYXJrZG93bkZpbGVzKGZvbGRlcik7XG4gICAgICAgIGxldCBtb3ZlZENvdW50ID0gMDtcbiAgICAgICAgY29uc3QgdmF1bHQgPSB0aGlzLmFwcC52YXVsdDtcblxuICAgICAgICBmb3IgKGNvbnN0IGZpbGUgb2YgZmlsZXMpIHtcbiAgICAgICAgICAgIGNvbnN0IGNhY2hlID0gdGhpcy5hcHAubWV0YWRhdGFDYWNoZS5nZXRGaWxlQ2FjaGUoZmlsZSk7XG4gICAgICAgICAgICBjb25zdCB0YWcgPSBjYWNoZT8uZnJvbnRtYXR0ZXI/LnRhZyB8fCAndW50YWdnZWQnO1xuXG4gICAgICAgICAgICAvLyBTa2lwIGlmIGFscmVhZHkgaW4gY29ycmVjdCBmb2xkZXJcbiAgICAgICAgICAgIGNvbnN0IGN1cnJlbnRGb2xkZXIgPSBmaWxlLnBhcmVudD8ubmFtZTtcbiAgICAgICAgICAgIGlmIChjdXJyZW50Rm9sZGVyID09PSB0YWcpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgICBjb25zdCB0YXJnZXRGb2xkZXJQYXRoID0gYCR7Zm9sZGVyLnBhdGh9LyR7dGFnfWA7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgLy8gQ3JlYXRlIHRhcmdldCBmb2xkZXIgaWYgaXQgZG9lc24ndCBleGlzdFxuICAgICAgICAgICAgICAgIGxldCB0YXJnZXRGb2xkZXIgPSB2YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgodGFyZ2V0Rm9sZGVyUGF0aCk7XG4gICAgICAgICAgICAgICAgaWYgKCF0YXJnZXRGb2xkZXIpIHtcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgdmF1bHQuY3JlYXRlRm9sZGVyKHRhcmdldEZvbGRlclBhdGgpO1xuICAgICAgICAgICAgICAgICAgICB0YXJnZXRGb2xkZXIgPSB2YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgodGFyZ2V0Rm9sZGVyUGF0aCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKHRhcmdldEZvbGRlciBpbnN0YW5jZW9mIFRGb2xkZXIpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbmV3UGF0aCA9IGAke3RhcmdldEZvbGRlclBhdGh9LyR7ZmlsZS5uYW1lfWA7XG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHZhdWx0LnJlbmFtZShmaWxlLCBuZXdQYXRoKTtcbiAgICAgICAgICAgICAgICAgICAgbW92ZWRDb3VudCsrO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5lcnJvcihgRXJyb3IgbW92aW5nIHRhc2sgJHtmaWxlLnBhdGh9OmAsIGVycm9yKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIG5ldyBOb3RpY2UoYE9yZ2FuaXplZCAke21vdmVkQ291bnR9IHRhc2tzIGluICR7Zm9sZGVyLm5hbWV9IGJ5IHRhZ2ApO1xuICAgICAgICB0aGlzLnJlZnJlc2hWaWV3KCk7XG4gICAgfVxuXG4gICAgLy8gRmluZCB0aGUgYmFzZSB0YXNrIGZvbGRlciBmb3IgYSBmaWxlXG4gICAgcHJpdmF0ZSBmaW5kQmFzZVRhc2tGb2xkZXIoZmlsZTogVEZpbGUpOiBURm9sZGVyIHwgbnVsbCB7XG4gICAgICAgIGxldCBjdXJyZW50ID0gZmlsZS5wYXJlbnQ7XG4gICAgICAgIFxuICAgICAgICB3aGlsZSAoY3VycmVudCkge1xuICAgICAgICAgICAgaWYgKHRoaXMuc2V0dGluZ3MudGFza0ZvbGRlcnMuc29tZSh0ZiA9PiBcbiAgICAgICAgICAgICAgICBjdXJyZW50IS5wYXRoID09PSB0ZiB8fCBcbiAgICAgICAgICAgICAgICBjdXJyZW50IS5wYXRoLmVuZHNXaXRoKCcvJyArIHRmKSB8fFxuICAgICAgICAgICAgICAgIGN1cnJlbnQhLm5hbWUgPT09IHRmXG4gICAgICAgICAgICApKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGN1cnJlbnQ7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjdXJyZW50ID0gY3VycmVudC5wYXJlbnQ7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbn1cblxuLy8gVGFzayBCb2FyZCBWaWV3XG5jbGFzcyBUYXNrQm9hcmRWaWV3IGV4dGVuZHMgSXRlbVZpZXcge1xuICAgIHBsdWdpbjogVGFza0JvYXJkUGx1Z2luO1xuICAgIHRhc2tzOiBUYXNrW10gPSBbXTtcbiAgICBjb250YWluZXJFbDogSFRNTEVsZW1lbnQ7XG4gICAgc29ydFNlbGVjdDogRHJvcGRvd25Db21wb25lbnQ7XG4gICAgc2VsZWN0ZWRUYWdzOiBTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoKTtcbiAgICB0YWdGaWx0ZXJDb250YWluZXI6IEhUTUxFbGVtZW50IHwgbnVsbCA9IG51bGw7XG4gICAgaGlkZGVuU3RhdHVzZXM6IFNldDxzdHJpbmc+ID0gbmV3IFNldCgpO1xuXG4gICAgY29uc3RydWN0b3IobGVhZjogV29ya3NwYWNlTGVhZiwgcGx1Z2luOiBUYXNrQm9hcmRQbHVnaW4pIHtcbiAgICAgICAgc3VwZXIobGVhZik7XG4gICAgICAgIHRoaXMucGx1Z2luID0gcGx1Z2luO1xuICAgICAgICAvLyBJbml0aWFsaXplIGhpZGRlbiBzdGF0dXNlcyBmcm9tIHNldHRpbmdzXG4gICAgICAgIHRoaXMuaGlkZGVuU3RhdHVzZXMgPSBuZXcgU2V0KHRoaXMucGx1Z2luLnNldHRpbmdzLmhpZGRlblN0YXR1c2VzIHx8IFtdKTtcbiAgICB9XG5cbiAgICBnZXRWaWV3VHlwZSgpOiBzdHJpbmcge1xuICAgICAgICByZXR1cm4gVklFV19UWVBFX1RBU0tfQk9BUkQ7XG4gICAgfVxuXG4gICAgZ2V0RGlzcGxheVRleHQoKTogc3RyaW5nIHtcbiAgICAgICAgcmV0dXJuICdUYXNrIEJvYXJkJztcbiAgICB9XG5cbiAgICBnZXRJY29uKCk6IHN0cmluZyB7XG4gICAgICAgIHJldHVybiAnbGF5b3V0LWJvYXJkJztcbiAgICB9XG5cbiAgICBhc3luYyBvbk9wZW4oKSB7XG4gICAgICAgIHRoaXMuY29udGFpbmVyRWwgPSB0aGlzLmNvbnRlbnRFbC5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLWJvYXJkLWNvbnRhaW5lcicgfSk7XG4gICAgICAgIGF3YWl0IHRoaXMucmVmcmVzaCgpO1xuICAgIH1cblxuICAgIGFzeW5jIHJlZnJlc2goKSB7XG4gICAgICAgIHRoaXMudGFza3MgPSBhd2FpdCB0aGlzLnBsdWdpbi5zY2FuVGFza3MoKTtcbiAgICAgICAgdGhpcy5yZW5kZXIoKTtcbiAgICB9XG5cbiAgICByZW5kZXIoKSB7XG4gICAgICAgIHRoaXMuY29udGFpbmVyRWwuZW1wdHkoKTtcblxuICAgICAgICAvLyBIZWFkZXIgd2l0aCBjb250cm9sc1xuICAgICAgICB0aGlzLnJlbmRlckhlYWRlcigpO1xuXG4gICAgICAgIC8vIFRhZyBmaWx0ZXJcbiAgICAgICAgdGhpcy5yZW5kZXJUYWdGaWx0ZXIoKTtcblxuICAgICAgICAvLyBCb2FyZFxuICAgICAgICB0aGlzLnJlbmRlckJvYXJkKCk7XG4gICAgfVxuXG4gICAgcmVuZGVySGVhZGVyKCkge1xuICAgICAgICBjb25zdCBoZWFkZXIgPSB0aGlzLmNvbnRhaW5lckVsLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stYm9hcmQtaGVhZGVyJyB9KTtcblxuICAgICAgICAvLyBUaXRsZVxuICAgICAgICBoZWFkZXIuY3JlYXRlRWwoJ2gyJywgeyB0ZXh0OiAnVGFzayBCb2FyZCcsIGNsczogJ3Rhc2stYm9hcmQtdGl0bGUnIH0pO1xuXG4gICAgICAgIC8vIENvbnRyb2xzXG4gICAgICAgIGNvbnN0IGNvbnRyb2xzID0gaGVhZGVyLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stYm9hcmQtY29udHJvbHMnIH0pO1xuXG4gICAgICAgIC8vIFNvcnQgZHJvcGRvd25cbiAgICAgICAgY29udHJvbHMuY3JlYXRlU3Bhbih7IHRleHQ6ICdTb3J0IGJ5OiAnLCBjbHM6ICd0YXNrLWJvYXJkLWxhYmVsJyB9KTtcbiAgICAgICAgY29uc3Qgc29ydFNlbGVjdCA9IG5ldyBEcm9wZG93bkNvbXBvbmVudChjb250cm9scyk7XG4gICAgICAgIHNvcnRTZWxlY3QuYWRkT3B0aW9uKCdwcmlvcml0eScsICdQcmlvcml0eScpO1xuICAgICAgICBzb3J0U2VsZWN0LmFkZE9wdGlvbigndGFnJywgJ1RhZycpO1xuICAgICAgICBzb3J0U2VsZWN0LmFkZE9wdGlvbigndGl0bGUnLCAnVGl0bGUnKTtcbiAgICAgICAgc29ydFNlbGVjdC5hZGRPcHRpb24oJ2ZvbGRlcicsICdGb2xkZXInKTtcbiAgICAgICAgc29ydFNlbGVjdC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5zb3J0QnkpO1xuICAgICAgICBzb3J0U2VsZWN0Lm9uQ2hhbmdlKCh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3Muc29ydEJ5ID0gdmFsdWUgYXMgYW55O1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgICB0aGlzLnJlbmRlckJvYXJkKCk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIFNvcnQgZGlyZWN0aW9uXG4gICAgICAgIGNvbnN0IGRpckJ0biA9IGNvbnRyb2xzLmNyZWF0ZUVsKCdidXR0b24nLCB7XG4gICAgICAgICAgICBjbHM6ICd0YXNrLWJvYXJkLXNvcnQtZGlyJyxcbiAgICAgICAgICAgIHRleHQ6IHRoaXMucGx1Z2luLnNldHRpbmdzLnNvcnREaXJlY3Rpb24gPT09ICdhc2MnID8gJ+KGkScgOiAn4oaTJ1xuICAgICAgICB9KTtcbiAgICAgICAgZGlyQnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3Muc29ydERpcmVjdGlvbiA9IFxuICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLnNvcnREaXJlY3Rpb24gPT09ICdhc2MnID8gJ2Rlc2MnIDogJ2FzYyc7XG4gICAgICAgICAgICBkaXJCdG4udGV4dENvbnRlbnQgPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zb3J0RGlyZWN0aW9uID09PSAnYXNjJyA/ICfihpEnIDogJ+KGkyc7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyQm9hcmQoKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gQ29sdW1uIHZpc2liaWxpdHkgdG9nZ2xlc1xuICAgICAgICBjb25zdCB2aXNpYmlsaXR5Q29udHJvbHMgPSBjb250cm9scy5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLWJvYXJkLXZpc2liaWxpdHknIH0pO1xuICAgICAgICB2aXNpYmlsaXR5Q29udHJvbHMuY3JlYXRlU3Bhbih7IHRleHQ6ICdTaG93OiAnLCBjbHM6ICd0YXNrLWJvYXJkLWxhYmVsJyB9KTtcblxuICAgICAgICAvLyBUb2dnbGUgZm9yIERvbmUgY29sdW1uXG4gICAgICAgIGNvbnN0IGRvbmVMYWJlbCA9IHZpc2liaWxpdHlDb250cm9scy5jcmVhdGVFbCgnbGFiZWwnLCB7IGNsczogJ3Zpc2liaWxpdHktdG9nZ2xlJyB9KTtcbiAgICAgICAgY29uc3QgZG9uZUNoZWNrYm94ID0gZG9uZUxhYmVsLmNyZWF0ZUVsKCdpbnB1dCcsIHtcbiAgICAgICAgICAgIHR5cGU6ICdjaGVja2JveCcsXG4gICAgICAgICAgICBjbHM6ICd2aXNpYmlsaXR5LWNoZWNrYm94J1xuICAgICAgICB9KTtcbiAgICAgICAgZG9uZUNoZWNrYm94LmNoZWNrZWQgPSAhdGhpcy5oaWRkZW5TdGF0dXNlcy5oYXMoJ2RvbmUnKTtcbiAgICAgICAgZG9uZUxhYmVsLmNyZWF0ZVNwYW4oeyB0ZXh0OiAnRG9uZScsIGNsczogJ3Zpc2liaWxpdHktdGV4dCcgfSk7XG4gICAgICAgIGRvbmVDaGVja2JveC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7XG4gICAgICAgICAgICBpZiAoZG9uZUNoZWNrYm94LmNoZWNrZWQpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmhpZGRlblN0YXR1c2VzLmRlbGV0ZSgnZG9uZScpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLmhpZGRlblN0YXR1c2VzLmFkZCgnZG9uZScpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MuaGlkZGVuU3RhdHVzZXMgPSBBcnJheS5mcm9tKHRoaXMuaGlkZGVuU3RhdHVzZXMpO1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgICB0aGlzLnJlbmRlckJvYXJkKCk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIFRvZ2dsZSBmb3IgQXJjaGl2ZSBjb2x1bW5cbiAgICAgICAgY29uc3QgYXJjaGl2ZUxhYmVsID0gdmlzaWJpbGl0eUNvbnRyb2xzLmNyZWF0ZUVsKCdsYWJlbCcsIHsgY2xzOiAndmlzaWJpbGl0eS10b2dnbGUnIH0pO1xuICAgICAgICBjb25zdCBhcmNoaXZlQ2hlY2tib3ggPSBhcmNoaXZlTGFiZWwuY3JlYXRlRWwoJ2lucHV0Jywge1xuICAgICAgICAgICAgdHlwZTogJ2NoZWNrYm94JyxcbiAgICAgICAgICAgIGNsczogJ3Zpc2liaWxpdHktY2hlY2tib3gnXG4gICAgICAgIH0pO1xuICAgICAgICBhcmNoaXZlQ2hlY2tib3guY2hlY2tlZCA9ICF0aGlzLmhpZGRlblN0YXR1c2VzLmhhcygnYXJjaGl2ZScpO1xuICAgICAgICBhcmNoaXZlTGFiZWwuY3JlYXRlU3Bhbih7IHRleHQ6ICdBcmNoaXZlJywgY2xzOiAndmlzaWJpbGl0eS10ZXh0JyB9KTtcbiAgICAgICAgYXJjaGl2ZUNoZWNrYm94LmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHtcbiAgICAgICAgICAgIGlmIChhcmNoaXZlQ2hlY2tib3guY2hlY2tlZCkge1xuICAgICAgICAgICAgICAgIHRoaXMuaGlkZGVuU3RhdHVzZXMuZGVsZXRlKCdhcmNoaXZlJyk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMuaGlkZGVuU3RhdHVzZXMuYWRkKCdhcmNoaXZlJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5oaWRkZW5TdGF0dXNlcyA9IEFycmF5LmZyb20odGhpcy5oaWRkZW5TdGF0dXNlcyk7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyQm9hcmQoKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gT3JnYW5pemUgYnkgdGFnIGJ1dHRvblxuICAgICAgICBjb25zdCBvcmdhbml6ZUJ0biA9IGNvbnRyb2xzLmNyZWF0ZUVsKCdidXR0b24nLCB7XG4gICAgICAgICAgICBjbHM6ICd0YXNrLWJvYXJkLW9yZ2FuaXplJyxcbiAgICAgICAgICAgIHRleHQ6ICfwn5OBIE9yZ2FuaXplJ1xuICAgICAgICB9KTtcbiAgICAgICAgb3JnYW5pemVCdG4udGl0bGUgPSAnT3JnYW5pemUgdGFza3MgYnkgdGFnJztcbiAgICAgICAgb3JnYW5pemVCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5vcmdhbml6ZVRhc2tzQnlUYWcoKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gUmVmcmVzaCBidXR0b25cbiAgICAgICAgY29uc3QgcmVmcmVzaEJ0biA9IGNvbnRyb2xzLmNyZWF0ZUVsKCdidXR0b24nLCB7XG4gICAgICAgICAgICBjbHM6ICd0YXNrLWJvYXJkLXJlZnJlc2gnLFxuICAgICAgICAgICAgdGV4dDogJ/CflIQnXG4gICAgICAgIH0pO1xuICAgICAgICByZWZyZXNoQnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdGhpcy5yZWZyZXNoKCkpO1xuXG4gICAgICAgIC8vIENsZWFyIGZpbHRlcnMgYnV0dG9uIChoaWRkZW4gYnkgZGVmYXVsdClcbiAgICAgICAgY29uc3QgY2xlYXJCdG4gPSBjb250cm9scy5jcmVhdGVFbCgnYnV0dG9uJywge1xuICAgICAgICAgICAgY2xzOiAndGFzay1ib2FyZC1jbGVhci1maWx0ZXJzJyxcbiAgICAgICAgICAgIHRleHQ6ICfinJUgQ2xlYXInXG4gICAgICAgIH0pO1xuICAgICAgICBjbGVhckJ0bi5zdHlsZS5kaXNwbGF5ID0gdGhpcy5zZWxlY3RlZFRhZ3Muc2l6ZSA+IDAgPyAnaW5saW5lLWJsb2NrJyA6ICdub25lJztcbiAgICAgICAgY2xlYXJCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnNlbGVjdGVkVGFncy5jbGVhcigpO1xuICAgICAgICAgICAgdGhpcy5yZW5kZXJUYWdGaWx0ZXIoKTtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyQm9hcmQoKTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gR2V0IGFsbCB1bmlxdWUgdGFncyBmcm9tIHRhc2tzXG4gICAgZ2V0QWxsVGFncygpOiBzdHJpbmdbXSB7XG4gICAgICAgIGNvbnN0IHRhZ3MgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICAgICAgZm9yIChjb25zdCB0YXNrIG9mIHRoaXMudGFza3MpIHtcbiAgICAgICAgICAgIGlmICh0YXNrLnRhZykge1xuICAgICAgICAgICAgICAgIHRhZ3MuYWRkKHRhc2sudGFnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gQXJyYXkuZnJvbSh0YWdzKS5zb3J0KCk7XG4gICAgfVxuXG4gICAgLy8gUmVuZGVyIHRhZyBmaWx0ZXIgY2hlY2tib3hlc1xuICAgIHJlbmRlclRhZ0ZpbHRlcigpIHtcbiAgICAgICAgLy8gUmVtb3ZlIGV4aXN0aW5nIGZpbHRlciBpZiBhbnlcbiAgICAgICAgaWYgKHRoaXMudGFnRmlsdGVyQ29udGFpbmVyKSB7XG4gICAgICAgICAgICB0aGlzLnRhZ0ZpbHRlckNvbnRhaW5lci5yZW1vdmUoKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHRhZ3MgPSB0aGlzLmdldEFsbFRhZ3MoKTtcbiAgICAgICAgaWYgKHRhZ3MubGVuZ3RoID09PSAwKSByZXR1cm47XG5cbiAgICAgICAgLy8gQXV0by1zZWxlY3QgYWxsIHRhZ3MgaWYgbm9uZSBzZWxlY3RlZCAoZGVmYXVsdCBiZWhhdmlvcilcbiAgICAgICAgaWYgKHRoaXMuc2VsZWN0ZWRUYWdzLnNpemUgPT09IDApIHtcbiAgICAgICAgICAgIHRhZ3MuZm9yRWFjaCh0YWcgPT4gdGhpcy5zZWxlY3RlZFRhZ3MuYWRkKHRhZykpO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy50YWdGaWx0ZXJDb250YWluZXIgPSB0aGlzLmNvbnRhaW5lckVsLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stdGFnLWZpbHRlcicgfSk7XG4gICAgICAgIFxuICAgICAgICBjb25zdCBmaWx0ZXJIZWFkZXIgPSB0aGlzLnRhZ0ZpbHRlckNvbnRhaW5lci5jcmVhdGVEaXYoeyBjbHM6ICd0YWctZmlsdGVyLWhlYWRlcicgfSk7XG4gICAgICAgIGZpbHRlckhlYWRlci5jcmVhdGVTcGFuKHsgdGV4dDogJ0ZpbHRlciBieSB0YWc6JywgY2xzOiAndGFnLWZpbHRlci1sYWJlbCcgfSk7XG5cbiAgICAgICAgLy8gU2VsZWN0IGFsbCAvIERlc2VsZWN0IGFsbCBidXR0b25zXG4gICAgICAgIGNvbnN0IGJ0bkdyb3VwID0gZmlsdGVySGVhZGVyLmNyZWF0ZURpdih7IGNsczogJ3RhZy1maWx0ZXItYnV0dG9ucycgfSk7XG4gICAgICAgIFxuICAgICAgICBjb25zdCBzZWxlY3RBbGxCdG4gPSBidG5Hcm91cC5jcmVhdGVFbCgnYnV0dG9uJywge1xuICAgICAgICAgICAgdGV4dDogJ0FsbCcsXG4gICAgICAgICAgICBjbHM6ICd0YWctZmlsdGVyLWJ0bidcbiAgICAgICAgfSk7XG4gICAgICAgIHNlbGVjdEFsbEJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgICAgIHRhZ3MuZm9yRWFjaCh0YWcgPT4gdGhpcy5zZWxlY3RlZFRhZ3MuYWRkKHRhZykpO1xuICAgICAgICAgICAgdGhpcy5yZW5kZXJUYWdGaWx0ZXIoKTtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyQm9hcmQoKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgY29uc3QgZGVzZWxlY3RBbGxCdG4gPSBidG5Hcm91cC5jcmVhdGVFbCgnYnV0dG9uJywge1xuICAgICAgICAgICAgdGV4dDogJ05vbmUnLFxuICAgICAgICAgICAgY2xzOiAndGFnLWZpbHRlci1idG4nXG4gICAgICAgIH0pO1xuICAgICAgICBkZXNlbGVjdEFsbEJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgICAgIHRoaXMuc2VsZWN0ZWRUYWdzLmNsZWFyKCk7XG4gICAgICAgICAgICB0aGlzLnJlbmRlclRhZ0ZpbHRlcigpO1xuICAgICAgICAgICAgdGhpcy5yZW5kZXJCb2FyZCgpO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBDaGVja2JveCBjb250YWluZXJcbiAgICAgICAgY29uc3QgY2hlY2tib3hDb250YWluZXIgPSB0aGlzLnRhZ0ZpbHRlckNvbnRhaW5lci5jcmVhdGVEaXYoeyBjbHM6ICd0YWctY2hlY2tib3gtY29udGFpbmVyJyB9KTtcblxuICAgICAgICBmb3IgKGNvbnN0IHRhZyBvZiB0YWdzKSB7XG4gICAgICAgICAgICBjb25zdCBsYWJlbCA9IGNoZWNrYm94Q29udGFpbmVyLmNyZWF0ZUVsKCdsYWJlbCcsIHsgY2xzOiAndGFnLWNoZWNrYm94LWxhYmVsJyB9KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29uc3QgY2hlY2tib3ggPSBsYWJlbC5jcmVhdGVFbCgnaW5wdXQnLCB7XG4gICAgICAgICAgICAgICAgdHlwZTogJ2NoZWNrYm94JyxcbiAgICAgICAgICAgICAgICBjbHM6ICd0YWctY2hlY2tib3gnXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGNoZWNrYm94LmNoZWNrZWQgPSB0aGlzLnNlbGVjdGVkVGFncy5oYXModGFnKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgbGFiZWwuY3JlYXRlU3Bhbih7IHRleHQ6IHRhZywgY2xzOiAndGFnLWNoZWNrYm94LXRleHQnIH0pO1xuXG4gICAgICAgICAgICAvLyBDb3VudCB0YXNrcyB3aXRoIHRoaXMgdGFnXG4gICAgICAgICAgICBjb25zdCBjb3VudCA9IHRoaXMudGFza3MuZmlsdGVyKHQgPT4gdC50YWcgPT09IHRhZykubGVuZ3RoO1xuICAgICAgICAgICAgbGFiZWwuY3JlYXRlU3Bhbih7IHRleHQ6IGAoJHtjb3VudH0pYCwgY2xzOiAndGFnLWNoZWNrYm94LWNvdW50JyB9KTtcblxuICAgICAgICAgICAgY2hlY2tib3guYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChjaGVja2JveC5jaGVja2VkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuc2VsZWN0ZWRUYWdzLmFkZCh0YWcpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuc2VsZWN0ZWRUYWdzLmRlbGV0ZSh0YWcpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB0aGlzLnJlbmRlckJvYXJkKCk7XG4gICAgICAgICAgICAgICAgLy8gVXBkYXRlIGNsZWFyIGJ1dHRvbiB2aXNpYmlsaXR5XG4gICAgICAgICAgICAgICAgY29uc3QgY2xlYXJCdG4gPSB0aGlzLmNvbnRhaW5lckVsLnF1ZXJ5U2VsZWN0b3IoJy50YXNrLWJvYXJkLWNsZWFyLWZpbHRlcnMnKSBhcyBIVE1MRWxlbWVudDtcbiAgICAgICAgICAgICAgICBpZiAoY2xlYXJCdG4pIHtcbiAgICAgICAgICAgICAgICAgICAgY2xlYXJCdG4uc3R5bGUuZGlzcGxheSA9IHRoaXMuc2VsZWN0ZWRUYWdzLnNpemUgPiAwID8gJ2lubGluZS1ibG9jaycgOiAnbm9uZSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZW5kZXJCb2FyZCgpIHtcbiAgICAgICAgLy8gUmVtb3ZlIGV4aXN0aW5nIGJvYXJkIGlmIGFueVxuICAgICAgICBjb25zdCBleGlzdGluZ0JvYXJkID0gdGhpcy5jb250YWluZXJFbC5xdWVyeVNlbGVjdG9yKCcudGFzay1ib2FyZCcpO1xuICAgICAgICBpZiAoZXhpc3RpbmdCb2FyZCkgZXhpc3RpbmdCb2FyZC5yZW1vdmUoKTtcblxuICAgICAgICBjb25zdCBib2FyZCA9IHRoaXMuY29udGFpbmVyRWwuY3JlYXRlRGl2KHsgY2xzOiAndGFzay1ib2FyZCcgfSk7XG5cbiAgICAgICAgLy8gRmlsdGVyIHRhc2tzIGJ5IHNlbGVjdGVkIHRhZ3NcbiAgICAgICAgbGV0IGZpbHRlcmVkVGFza3MgPSB0aGlzLnRhc2tzO1xuICAgICAgICBjb25zdCBhbGxUYWdzID0gdGhpcy5nZXRBbGxUYWdzKCk7XG4gICAgICAgIC8vIE9ubHkgZmlsdGVyIGlmIG5vdCBhbGwgdGFncyBhcmUgc2VsZWN0ZWRcbiAgICAgICAgaWYgKHRoaXMuc2VsZWN0ZWRUYWdzLnNpemUgPiAwICYmIHRoaXMuc2VsZWN0ZWRUYWdzLnNpemUgPCBhbGxUYWdzLmxlbmd0aCkge1xuICAgICAgICAgICAgZmlsdGVyZWRUYXNrcyA9IHRoaXMudGFza3MuZmlsdGVyKHRhc2sgPT4gdGhpcy5zZWxlY3RlZFRhZ3MuaGFzKHRhc2sudGFnKSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBHcm91cCB0YXNrcyBieSBzdGF0dXNcbiAgICAgICAgY29uc3QgdGFza3NCeVN0YXR1cyA9IG5ldyBNYXA8c3RyaW5nLCBUYXNrW10+KCk7XG4gICAgICAgIFxuICAgICAgICAvLyBJbml0aWFsaXplIHdpdGggY29uZmlndXJlZCBzdGF0dXMgb3JkZXJcbiAgICAgICAgZm9yIChjb25zdCBzdGF0dXMgb2YgdGhpcy5wbHVnaW4uc2V0dGluZ3Muc3RhdHVzT3JkZXIpIHtcbiAgICAgICAgICAgIHRhc2tzQnlTdGF0dXMuc2V0KHN0YXR1cywgW10pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gR3JvdXAgdGFza3NcbiAgICAgICAgZm9yIChjb25zdCB0YXNrIG9mIGZpbHRlcmVkVGFza3MpIHtcbiAgICAgICAgICAgIGNvbnN0IHN0YXR1cyA9IHRhc2suc3RhdHVzIHx8IHRoaXMucGx1Z2luLnNldHRpbmdzLmRlZmF1bHRTdGF0dXM7XG4gICAgICAgICAgICBpZiAoIXRhc2tzQnlTdGF0dXMuaGFzKHN0YXR1cykpIHtcbiAgICAgICAgICAgICAgICB0YXNrc0J5U3RhdHVzLnNldChzdGF0dXMsIFtdKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRhc2tzQnlTdGF0dXMuZ2V0KHN0YXR1cykhLnB1c2godGFzayk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBDcmVhdGUgY29sdW1ucyAoc2tpcCBoaWRkZW4gc3RhdHVzZXMpXG4gICAgICAgIGZvciAoY29uc3Qgc3RhdHVzIG9mIHRoaXMucGx1Z2luLnNldHRpbmdzLnN0YXR1c09yZGVyKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5oaWRkZW5TdGF0dXNlcy5oYXMoc3RhdHVzKSkgY29udGludWU7XG4gICAgICAgICAgICBjb25zdCB0YXNrcyA9IHRhc2tzQnlTdGF0dXMuZ2V0KHN0YXR1cykgfHwgW107XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIEZvciBhY3RpdmUgY29sdW1ucyAodG9kbywgaW4tcHJvZ3Jlc3MpLCB1c2UgaGllcmFyY2hpY2FsIGdyb3VwaW5nXG4gICAgICAgICAgICBpZiAoc3RhdHVzID09PSAndG9kbycgfHwgc3RhdHVzID09PSAnaW4tcHJvZ3Jlc3MnKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5yZW5kZXJIaWVyYXJjaGljYWxDb2x1bW4oYm9hcmQsIHN0YXR1cywgdGFza3MpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyBTb3J0IGFuZCByZW5kZXIgZmxhdCBmb3IgZG9uZS9hcmNoaXZlIGNvbHVtbnNcbiAgICAgICAgICAgICAgICB0aGlzLnNvcnRUYXNrcyh0YXNrcyk7XG4gICAgICAgICAgICAgICAgdGhpcy5yZW5kZXJDb2x1bW4oYm9hcmQsIHN0YXR1cywgdGFza3MpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gR3JvdXAgdGFza3MgYnkgZm9sZGVyLCB0aGVuIGJ5IHRhZ1xuICAgIGdyb3VwVGFza3NIaWVyYXJjaGljYWxseSh0YXNrczogVGFza1tdKTogTWFwPHN0cmluZywgTWFwPHN0cmluZywgVGFza1tdPj4ge1xuICAgICAgICBjb25zdCBmb2xkZXJHcm91cHMgPSBuZXcgTWFwPHN0cmluZywgTWFwPHN0cmluZywgVGFza1tdPj4oKTtcblxuICAgICAgICBmb3IgKGNvbnN0IHRhc2sgb2YgdGFza3MpIHtcbiAgICAgICAgICAgIGNvbnN0IGZvbGRlciA9IHRhc2suZm9sZGVyIHx8ICdVbmNhdGVnb3JpemVkJztcbiAgICAgICAgICAgIGNvbnN0IHRhZyA9IHRhc2sudGFnIHx8ICd1bnRhZ2dlZCc7XG5cbiAgICAgICAgICAgIGlmICghZm9sZGVyR3JvdXBzLmhhcyhmb2xkZXIpKSB7XG4gICAgICAgICAgICAgICAgZm9sZGVyR3JvdXBzLnNldChmb2xkZXIsIG5ldyBNYXAoKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCB0YWdHcm91cHMgPSBmb2xkZXJHcm91cHMuZ2V0KGZvbGRlcikhO1xuXG4gICAgICAgICAgICBpZiAoIXRhZ0dyb3Vwcy5oYXModGFnKSkge1xuICAgICAgICAgICAgICAgIHRhZ0dyb3Vwcy5zZXQodGFnLCBbXSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0YWdHcm91cHMuZ2V0KHRhZykhLnB1c2godGFzayk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBTb3J0IHRhc2tzIHdpdGhpbiBlYWNoIHRhZyBncm91cFxuICAgICAgICBmb3IgKGNvbnN0IFtmb2xkZXIsIHRhZ0dyb3Vwc10gb2YgZm9sZGVyR3JvdXBzKSB7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IFt0YWcsIHRhZ1Rhc2tzXSBvZiB0YWdHcm91cHMpIHtcbiAgICAgICAgICAgICAgICB0aGlzLnNvcnRUYXNrcyh0YWdUYXNrcyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gZm9sZGVyR3JvdXBzO1xuICAgIH1cblxuICAgIHJlbmRlckhpZXJhcmNoaWNhbENvbHVtbihib2FyZDogSFRNTEVsZW1lbnQsIHN0YXR1czogc3RyaW5nLCB0YXNrczogVGFza1tdKSB7XG4gICAgICAgIGNvbnN0IGNvbHVtbiA9IGJvYXJkLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stYm9hcmQtY29sdW1uIGhpZXJhcmNoaWNhbCcgfSk7XG4gICAgICAgIGNvbHVtbi5zZXRBdHRyaWJ1dGUoJ2RhdGEtc3RhdHVzJywgc3RhdHVzKTtcblxuICAgICAgICAvLyBHcm91cCB0YXNrcyBoaWVyYXJjaGljYWxseVxuICAgICAgICBjb25zdCBmb2xkZXJHcm91cHMgPSB0aGlzLmdyb3VwVGFza3NIaWVyYXJjaGljYWxseSh0YXNrcyk7XG5cbiAgICAgICAgLy8gQ2FsY3VsYXRlIGR5bmFtaWMgd2lkdGggYmFzZWQgb24gbnVtYmVyIG9mIHRhZ3MgYW5kIGZvbGRlcnNcbiAgICAgICAgY29uc3QgY29sdW1uV2lkdGggPSB0aGlzLmNhbGN1bGF0ZUNvbHVtbldpZHRoKGZvbGRlckdyb3Vwcyk7XG4gICAgICAgIGNvbHVtbi5zdHlsZS53aWR0aCA9IGAke2NvbHVtbldpZHRofXB4YDtcbiAgICAgICAgY29sdW1uLnN0eWxlLm1pbldpZHRoID0gYCR7Y29sdW1uV2lkdGh9cHhgO1xuICAgICAgICBjb2x1bW4uc3R5bGUuZmxleCA9IGAwIDAgJHtjb2x1bW5XaWR0aH1weGA7XG5cbiAgICAgICAgLy8gQ29sdW1uIGhlYWRlciB3aXRoIGRyb3Agem9uZSBmb3Igc3RhdHVzIGNoYW5nZVxuICAgICAgICBjb25zdCBoZWFkZXIgPSBjb2x1bW4uY3JlYXRlRGl2KHsgY2xzOiAndGFzay1jb2x1bW4taGVhZGVyJyB9KTtcbiAgICAgICAgY29uc3Qgc3RhdHVzTGFiZWwgPSB0aGlzLmdldFN0YXR1c0xhYmVsKHN0YXR1cyk7XG4gICAgICAgIGhlYWRlci5jcmVhdGVFbCgnaDMnLCB7IHRleHQ6IHN0YXR1c0xhYmVsLCBjbHM6IGB0YXNrLWNvbHVtbi10aXRsZSBzdGF0dXMtJHtzdGF0dXN9YCB9KTtcbiAgICAgICAgaGVhZGVyLmNyZWF0ZVNwYW4oeyB0ZXh0OiBgJHt0YXNrcy5sZW5ndGh9YCwgY2xzOiAndGFzay1jb3VudCcgfSk7XG4gICAgICAgIFxuICAgICAgICAvLyBNYWtlIGVudGlyZSBjb2x1bW4gYSBkcm9wIHpvbmUgZm9yIHN0YXR1c1xuICAgICAgICB0aGlzLnNldHVwRHJvcFpvbmUoY29sdW1uLCAnc3RhdHVzJywgc3RhdHVzKTtcblxuICAgICAgICAvLyBUYXNrcyBjb250YWluZXIgd2l0aCBob3Jpem9udGFsIGxheW91dFxuICAgICAgICBjb25zdCB0YXNrc0NvbnRhaW5lciA9IGNvbHVtbi5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLWNvbHVtbi10YXNrcyBoaWVyYXJjaGljYWwnIH0pO1xuXG4gICAgICAgIC8vIFNvcnQgZm9sZGVycyBhbHBoYWJldGljYWxseVxuICAgICAgICBjb25zdCBzb3J0ZWRGb2xkZXJzID0gQXJyYXkuZnJvbShmb2xkZXJHcm91cHMua2V5cygpKS5zb3J0KCk7XG5cbiAgICAgICAgLy8gUmVuZGVyIGVhY2ggZm9sZGVyXG4gICAgICAgIGZvciAoY29uc3QgZm9sZGVyTmFtZSBvZiBzb3J0ZWRGb2xkZXJzKSB7XG4gICAgICAgICAgICBjb25zdCB0YWdHcm91cHMgPSBmb2xkZXJHcm91cHMuZ2V0KGZvbGRlck5hbWUpITtcbiAgICAgICAgICAgIC8vIENhbGN1bGF0ZSBmb2xkZXIgc2VjdGlvbiB3aWR0aCBiYXNlZCBvbiB0YWdzXG4gICAgICAgICAgICBjb25zdCBmb2xkZXJXaWR0aCA9IHRoaXMuY2FsY3VsYXRlRm9sZGVyV2lkdGgodGFnR3JvdXBzKTtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyRm9sZGVyU2VjdGlvbih0YXNrc0NvbnRhaW5lciwgZm9sZGVyTmFtZSwgdGFnR3JvdXBzLCBmb2xkZXJXaWR0aCwgc3RhdHVzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEVtcHR5IHN0YXRlXG4gICAgICAgIGlmICh0YXNrcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgIHRhc2tzQ29udGFpbmVyLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stZW1wdHknLCB0ZXh0OiAnTm8gdGFza3MnIH0pO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gQ2FsY3VsYXRlIG9wdGltYWwgY29sdW1uIHdpZHRoIGJhc2VkIG9uIGZvbGRlciBhbmQgdGFnIGNvdW50c1xuICAgIGNhbGN1bGF0ZUNvbHVtbldpZHRoKGZvbGRlckdyb3VwczogTWFwPHN0cmluZywgTWFwPHN0cmluZywgVGFza1tdPj4pOiBudW1iZXIge1xuICAgICAgICBjb25zdCBUQUdfV0lEVEggPSAyMDA7ICAgICAgLy8gV2lkdGggcGVyIHRhZyBncm91cCAoaW5jbHVkaW5nIHBhZGRpbmcgJiBib3JkZXIpXG4gICAgICAgIGNvbnN0IFRBR19HQVAgPSAxMjsgICAgICAgICAvLyBHYXAgYmV0d2VlbiB0YWdzXG4gICAgICAgIGNvbnN0IFNFQ1RJT05fUEFERElORyA9IDQ4OyAvLyBGb2xkZXIgc2VjdGlvbiBpbnRlcm5hbCBwYWRkaW5nICgxNnB4ICogMiArIG1hcmdpbilcbiAgICAgICAgY29uc3QgQ09MVU1OX1BBRERJTkcgPSA0ODsgIC8vIENvbHVtbiBjb250ZW50IHBhZGRpbmcgKDEycHggKiAyICsgZXh0cmEpXG4gICAgICAgIGNvbnN0IE1JTl9XSURUSCA9IDQwMDsgICAgICAvLyBNaW5pbXVtIGNvbHVtbiB3aWR0aFxuXG4gICAgICAgIGxldCBtYXhGb2xkZXJXaWR0aCA9IDA7XG5cbiAgICAgICAgLy8gQ2FsY3VsYXRlIHdpZHRoIGZvciBlYWNoIGZvbGRlciAoYWxsIHRhZ3MgaW4gb25lIGxpbmUpXG4gICAgICAgIGZvciAoY29uc3QgW2ZvbGRlciwgdGFnR3JvdXBzXSBvZiBmb2xkZXJHcm91cHMpIHtcbiAgICAgICAgICAgIGNvbnN0IHRhZ0NvdW50ID0gdGFnR3JvdXBzLnNpemU7XG4gICAgICAgICAgICAvLyBBY2NvdW50IGZvciB0YWdzLCBnYXBzIGJldHdlZW4gdGhlbSwgYW5kIGNvbnRhaW5lciBwYWRkaW5nXG4gICAgICAgICAgICBjb25zdCBjb250ZW50V2lkdGggPSAodGFnQ291bnQgKiBUQUdfV0lEVEgpICsgKCh0YWdDb3VudCAtIDEpICogVEFHX0dBUCk7XG4gICAgICAgICAgICBjb25zdCBmb2xkZXJXaWR0aCA9IGNvbnRlbnRXaWR0aCArIFNFQ1RJT05fUEFERElORztcbiAgICAgICAgICAgIG1heEZvbGRlcldpZHRoID0gTWF0aC5tYXgobWF4Rm9sZGVyV2lkdGgsIGZvbGRlcldpZHRoKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFJldHVybiB0aGUgd2lkdGggbmVlZGVkIGZvciB0aGUgd2lkZXN0IGZvbGRlciBwbHVzIGNvbHVtbiBwYWRkaW5nXG4gICAgICAgIHJldHVybiBNYXRoLm1heChNSU5fV0lEVEgsIG1heEZvbGRlcldpZHRoICsgQ09MVU1OX1BBRERJTkcpO1xuICAgIH1cblxuICAgIC8vIENhbGN1bGF0ZSBmb2xkZXIgc2VjdGlvbiB3aWR0aCAtIG1hdGNoZXMgY29sdW1uIHdpZHRoIGNhbGN1bGF0aW9uXG4gICAgY2FsY3VsYXRlRm9sZGVyV2lkdGgodGFnR3JvdXBzOiBNYXA8c3RyaW5nLCBUYXNrW10+KTogbnVtYmVyIHtcbiAgICAgICAgY29uc3QgVEFHX1dJRFRIID0gMjAwO1xuICAgICAgICBjb25zdCBUQUdfR0FQID0gMTI7XG4gICAgICAgIGNvbnN0IFBBRERJTkcgPSA0ODtcblxuICAgICAgICBjb25zdCB0YWdDb3VudCA9IHRhZ0dyb3Vwcy5zaXplO1xuICAgICAgICBjb25zdCBjb250ZW50V2lkdGggPSAodGFnQ291bnQgKiBUQUdfV0lEVEgpICsgKCh0YWdDb3VudCAtIDEpICogVEFHX0dBUCk7XG4gICAgICAgIHJldHVybiBjb250ZW50V2lkdGggKyBQQURESU5HO1xuICAgIH1cblxuICAgIHJlbmRlckZvbGRlclNlY3Rpb24oY29udGFpbmVyOiBIVE1MRWxlbWVudCwgZm9sZGVyTmFtZTogc3RyaW5nLCB0YWdHcm91cHM6IE1hcDxzdHJpbmcsIFRhc2tbXT4sIHdpZHRoPzogbnVtYmVyLCBzdGF0dXM/OiBzdHJpbmcpIHtcbiAgICAgICAgY29uc3QgZm9sZGVyU2VjdGlvbiA9IGNvbnRhaW5lci5jcmVhdGVEaXYoeyBjbHM6ICdmb2xkZXItc2VjdGlvbicgfSk7XG4gICAgICAgIGZvbGRlclNlY3Rpb24uc2V0QXR0cmlidXRlKCdkYXRhLWZvbGRlcicsIGZvbGRlck5hbWUpO1xuICAgICAgICBcbiAgICAgICAgLy8gQXBwbHkgY2FsY3VsYXRlZCB3aWR0aCBpZiBwcm92aWRlZFxuICAgICAgICBpZiAod2lkdGggJiYgd2lkdGggPiAwKSB7XG4gICAgICAgICAgICBmb2xkZXJTZWN0aW9uLnN0eWxlLndpZHRoID0gYCR7d2lkdGh9cHhgO1xuICAgICAgICAgICAgZm9sZGVyU2VjdGlvbi5zdHlsZS5taW5XaWR0aCA9IGAke3dpZHRofXB4YDtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEZvbGRlciBoZWFkZXIgd2l0aCBkcm9wIGluZGljYXRvciBhbmQgKyBidXR0b25cbiAgICAgICAgY29uc3QgZm9sZGVySGVhZGVyID0gZm9sZGVyU2VjdGlvbi5jcmVhdGVEaXYoeyBjbHM6ICdmb2xkZXItaGVhZGVyJyB9KTtcbiAgICAgICAgY29uc3QgZm9sZGVyVGl0bGVDb250YWluZXIgPSBmb2xkZXJIZWFkZXIuY3JlYXRlRGl2KHsgY2xzOiAnZm9sZGVyLXRpdGxlLWNvbnRhaW5lcicgfSk7XG4gICAgICAgIGZvbGRlclRpdGxlQ29udGFpbmVyLmNyZWF0ZUVsKCdoNCcsIHsgdGV4dDogZm9sZGVyTmFtZSwgY2xzOiAnZm9sZGVyLXRpdGxlJyB9KTtcbiAgICAgICAgXG4gICAgICAgIC8vIEFkZCBcIitcIiBidXR0b24gbmV4dCB0byBmb2xkZXIgbmFtZVxuICAgICAgICBjb25zdCBhZGRUYWdCdG4gPSBmb2xkZXJUaXRsZUNvbnRhaW5lci5jcmVhdGVFbCgnYnV0dG9uJywge1xuICAgICAgICAgICAgY2xzOiAnYWRkLXRhZy1idG4taGVhZGVyJyxcbiAgICAgICAgICAgIHRleHQ6ICcrJyxcbiAgICAgICAgICAgIGF0dHI6IHsgdGl0bGU6ICdBZGQgbmV3IHRhZycgfVxuICAgICAgICB9KTtcbiAgICAgICAgYWRkVGFnQnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICAgICAgdGhpcy5zaG93TmV3VGFnRGlhbG9nKGZvbGRlck5hbWUpO1xuICAgICAgICB9KTtcbiAgICAgICAgXG4gICAgICAgIGNvbnN0IHRvdGFsVGFza3MgPSBBcnJheS5mcm9tKHRhZ0dyb3Vwcy52YWx1ZXMoKSkucmVkdWNlKChzdW0sIHRhc2tzKSA9PiBzdW0gKyB0YXNrcy5sZW5ndGgsIDApO1xuICAgICAgICBmb2xkZXJIZWFkZXIuY3JlYXRlU3Bhbih7IHRleHQ6IGAke3RvdGFsVGFza3N9YCwgY2xzOiAnZm9sZGVyLWNvdW50JyB9KTtcblxuICAgICAgICAvLyBIb3Jpem9udGFsIGNvbnRhaW5lciBmb3IgdGFnIGdyb3Vwc1xuICAgICAgICBjb25zdCB0YWdzQ29udGFpbmVyID0gZm9sZGVyU2VjdGlvbi5jcmVhdGVEaXYoeyBjbHM6ICd0YWdzLWNvbnRhaW5lcicgfSk7XG5cbiAgICAgICAgLy8gU29ydCB0YWdzIGFscGhhYmV0aWNhbGx5XG4gICAgICAgIGNvbnN0IHNvcnRlZFRhZ3MgPSBBcnJheS5mcm9tKHRhZ0dyb3Vwcy5rZXlzKCkpLnNvcnQoKTtcblxuICAgICAgICAvLyBSZW5kZXIgZWFjaCB0YWcgZ3JvdXBcbiAgICAgICAgZm9yIChjb25zdCB0YWcgb2Ygc29ydGVkVGFncykge1xuICAgICAgICAgICAgY29uc3QgdGFza3MgPSB0YWdHcm91cHMuZ2V0KHRhZykhO1xuICAgICAgICAgICAgdGhpcy5yZW5kZXJUYWdHcm91cCh0YWdzQ29udGFpbmVyLCBmb2xkZXJOYW1lLCB0YWcsIHRhc2tzKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJlbmRlclRhZ0dyb3VwKGNvbnRhaW5lcjogSFRNTEVsZW1lbnQsIGZvbGRlck5hbWU6IHN0cmluZywgdGFnOiBzdHJpbmcsIHRhc2tzOiBUYXNrW10pIHtcbiAgICAgICAgY29uc3QgdGFnR3JvdXAgPSBjb250YWluZXIuY3JlYXRlRGl2KHsgY2xzOiAndGFnLWdyb3VwJyB9KTtcbiAgICAgICAgdGFnR3JvdXAuc2V0QXR0cmlidXRlKCdkYXRhLXRhZycsIHRhZyk7XG5cbiAgICAgICAgLy8gVGFnIGhlYWRlclxuICAgICAgICBjb25zdCB0YWdIZWFkZXIgPSB0YWdHcm91cC5jcmVhdGVEaXYoeyBjbHM6ICd0YWctaGVhZGVyJyB9KTtcbiAgICAgICAgdGFnSGVhZGVyLmNyZWF0ZVNwYW4oeyB0ZXh0OiB0YWcsIGNsczogJ3RhZy1ncm91cC1uYW1lJyB9KTtcbiAgICAgICAgdGFnSGVhZGVyLmNyZWF0ZVNwYW4oeyB0ZXh0OiBgJHt0YXNrcy5sZW5ndGh9YCwgY2xzOiAndGFnLWdyb3VwLWNvdW50JyB9KTtcblxuICAgICAgICAvLyBUYXNrcyBpbiB0aGlzIHRhZyBncm91cCB3aXRoIGRyb3Agem9uZSBmb3IgdGFnIGNoYW5nZXNcbiAgICAgICAgY29uc3QgdGFza3NDb250YWluZXIgPSB0YWdHcm91cC5jcmVhdGVEaXYoeyBjbHM6ICd0YWctdGFza3MnIH0pO1xuICAgICAgICB0aGlzLnNldHVwRHJvcFpvbmUodGFza3NDb250YWluZXIsICd0YWcnLCB0YWcpO1xuXG4gICAgICAgIGZvciAoY29uc3QgdGFzayBvZiB0YXNrcykge1xuICAgICAgICAgICAgdGhpcy5yZW5kZXJUYXNrQ2FyZCh0YXNrc0NvbnRhaW5lciwgdGFzayk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBcIk5ld1wiIGJ1dHRvbiBhdCB0aGUgZW5kIG9mIHRhZyBncm91cFxuICAgICAgICBjb25zdCBuZXdUYXNrQnRuID0gdGFnR3JvdXAuY3JlYXRlRWwoJ2J1dHRvbicsIHtcbiAgICAgICAgICAgIGNsczogJ25ldy10YXNrLWJ0bicsXG4gICAgICAgICAgICB0ZXh0OiAnTmV3J1xuICAgICAgICB9KTtcbiAgICAgICAgbmV3VGFza0J0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgICAgIHRoaXMuc2hvd05ld1Rhc2tEaWFsb2coZm9sZGVyTmFtZSwgdGFnKTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgc29ydFRhc2tzKHRhc2tzOiBUYXNrW10pIHtcbiAgICAgICAgY29uc3Qgc29ydEJ5ID0gdGhpcy5wbHVnaW4uc2V0dGluZ3Muc29ydEJ5O1xuICAgICAgICBjb25zdCBkaXJlY3Rpb24gPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zb3J0RGlyZWN0aW9uO1xuICAgICAgICBjb25zdCBtdWx0aXBsaWVyID0gZGlyZWN0aW9uID09PSAnYXNjJyA/IDEgOiAtMTtcblxuICAgICAgICB0YXNrcy5zb3J0KChhLCBiKSA9PiB7XG4gICAgICAgICAgICBsZXQgY29tcGFyaXNvbiA9IDA7XG5cbiAgICAgICAgICAgIHN3aXRjaCAoc29ydEJ5KSB7XG4gICAgICAgICAgICAgICAgY2FzZSAncHJpb3JpdHknOlxuICAgICAgICAgICAgICAgICAgICBjb25zdCBwcmlvcml0eU1hcCA9IHsgaGlnaDogMywgbWVkaXVtOiAyLCBsb3c6IDEgfTtcbiAgICAgICAgICAgICAgICAgICAgY29tcGFyaXNvbiA9IHByaW9yaXR5TWFwW2EucHJpb3JpdHldIC0gcHJpb3JpdHlNYXBbYi5wcmlvcml0eV07XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGNhc2UgJ3RhZyc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBhcmlzb24gPSBhLnRhZy5sb2NhbGVDb21wYXJlKGIudGFnKTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgY2FzZSAndGl0bGUnOlxuICAgICAgICAgICAgICAgICAgICBjb21wYXJpc29uID0gYS50aXRsZS5sb2NhbGVDb21wYXJlKGIudGl0bGUpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlICdmb2xkZXInOlxuICAgICAgICAgICAgICAgICAgICBjb21wYXJpc29uID0gYS5mb2xkZXIubG9jYWxlQ29tcGFyZShiLmZvbGRlcik7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gY29tcGFyaXNvbiAqIG11bHRpcGxpZXI7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIHJlbmRlckNvbHVtbihib2FyZDogSFRNTEVsZW1lbnQsIHN0YXR1czogc3RyaW5nLCB0YXNrczogVGFza1tdKSB7XG4gICAgICAgIGNvbnN0IGNvbHVtbiA9IGJvYXJkLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stYm9hcmQtY29sdW1uJyB9KTtcbiAgICAgICAgY29sdW1uLnNldEF0dHJpYnV0ZSgnZGF0YS1zdGF0dXMnLCBzdGF0dXMpO1xuXG4gICAgICAgIC8vIENvbHVtbiBoZWFkZXJcbiAgICAgICAgY29uc3QgaGVhZGVyID0gY29sdW1uLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stY29sdW1uLWhlYWRlcicgfSk7XG4gICAgICAgIGNvbnN0IHN0YXR1c0xhYmVsID0gdGhpcy5nZXRTdGF0dXNMYWJlbChzdGF0dXMpO1xuICAgICAgICBoZWFkZXIuY3JlYXRlRWwoJ2gzJywgeyB0ZXh0OiBzdGF0dXNMYWJlbCwgY2xzOiBgdGFzay1jb2x1bW4tdGl0bGUgc3RhdHVzLSR7c3RhdHVzfWAgfSk7XG4gICAgICAgIGhlYWRlci5jcmVhdGVTcGFuKHsgdGV4dDogYCR7dGFza3MubGVuZ3RofWAsIGNsczogJ3Rhc2stY291bnQnIH0pO1xuXG4gICAgICAgIC8vIFRhc2tzIGNvbnRhaW5lciB3aXRoIGRyb3Agem9uZVxuICAgICAgICBjb25zdCB0YXNrc0NvbnRhaW5lciA9IGNvbHVtbi5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLWNvbHVtbi10YXNrcycgfSk7XG4gICAgICAgIHRoaXMuc2V0dXBEcm9wWm9uZSh0YXNrc0NvbnRhaW5lciwgJ3N0YXR1cycsIHN0YXR1cyk7XG5cbiAgICAgICAgLy8gUmVuZGVyIHRhc2tzXG4gICAgICAgIGZvciAoY29uc3QgdGFzayBvZiB0YXNrcykge1xuICAgICAgICAgICAgdGhpcy5yZW5kZXJUYXNrQ2FyZCh0YXNrc0NvbnRhaW5lciwgdGFzayk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBTZXR1cCBkcm9wIHpvbmUgZm9yIGRyYWcgYW5kIGRyb3BcbiAgICBzZXR1cERyb3Bab25lKGVsZW1lbnQ6IEhUTUxFbGVtZW50LCB0eXBlOiAnc3RhdHVzJyB8ICd0YWcnIHwgJ2ZvbGRlcicsIHZhbHVlOiBzdHJpbmcsIGZvbGRlcj86IFRGb2xkZXIpIHtcbiAgICAgICAgZWxlbWVudC5hZGRFdmVudExpc3RlbmVyKCdkcmFnb3ZlcicsIChlKSA9PiB7XG4gICAgICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgICAgICBlbGVtZW50LmNsYXNzTGlzdC5hZGQoJ2Ryb3AtdGFyZ2V0Jyk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGVsZW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignZHJhZ2xlYXZlJywgKCkgPT4ge1xuICAgICAgICAgICAgZWxlbWVudC5jbGFzc0xpc3QucmVtb3ZlKCdkcm9wLXRhcmdldCcpO1xuICAgICAgICB9KTtcblxuICAgICAgICBlbGVtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2Ryb3AnLCBhc3luYyAoZSkgPT4ge1xuICAgICAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICAgICAgZWxlbWVudC5jbGFzc0xpc3QucmVtb3ZlKCdkcm9wLXRhcmdldCcpO1xuXG4gICAgICAgICAgICBjb25zdCB0YXNrSWQgPSBlLmRhdGFUcmFuc2Zlcj8uZ2V0RGF0YSgndGV4dC9wbGFpbicpO1xuICAgICAgICAgICAgaWYgKCF0YXNrSWQpIHJldHVybjtcblxuICAgICAgICAgICAgY29uc3QgdGFzayA9IHRoaXMudGFza3MuZmluZCh0ID0+IHQuaWQgPT09IHRhc2tJZCk7XG4gICAgICAgICAgICBpZiAoIXRhc2spIHJldHVybjtcblxuICAgICAgICAgICAgLy8gUHJldmVudCBkcm9wcGluZyBvbiBzYW1lIGxvY2F0aW9uXG4gICAgICAgICAgICBpZiAodHlwZSA9PT0gJ3N0YXR1cycgJiYgdGFzay5zdGF0dXMgPT09IHZhbHVlKSByZXR1cm47XG4gICAgICAgICAgICBpZiAodHlwZSA9PT0gJ3RhZycgJiYgdGFzay50YWcgPT09IHZhbHVlKSByZXR1cm47XG4gICAgICAgICAgICBpZiAodHlwZSA9PT0gJ2ZvbGRlcicgJiYgZm9sZGVyICYmIHRhc2suZmlsZS5wYXJlbnQ/LnBhdGggPT09IGZvbGRlci5wYXRoKSByZXR1cm47XG5cbiAgICAgICAgICAgIC8vIFBlcmZvcm0gdGhlIG1vdmVcbiAgICAgICAgICAgIGlmICh0eXBlID09PSAnc3RhdHVzJykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnVwZGF0ZVRhc2tTdGF0dXModGFzaywgdmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmICh0eXBlID09PSAndGFnJykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnVwZGF0ZVRhc2sodGFzaywgdmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmICh0eXBlID09PSAnZm9sZGVyJyAmJiBmb2xkZXIpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5tb3ZlVGFza1RvRm9sZGVyKHRhc2ssIGZvbGRlcik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRoaXMucmVmcmVzaCgpO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICByZW5kZXJUYXNrQ2FyZChjb250YWluZXI6IEhUTUxFbGVtZW50LCB0YXNrOiBUYXNrKSB7XG4gICAgICAgIGNvbnN0IGNhcmQgPSBjb250YWluZXIuY3JlYXRlRGl2KHsgY2xzOiBgdGFzay1jYXJkIHByaW9yaXR5LSR7dGFzay5wcmlvcml0eX1gIH0pO1xuICAgICAgICBjYXJkLnNldEF0dHJpYnV0ZSgnZGF0YS10YXNrLWlkJywgdGFzay5pZCk7XG5cbiAgICAgICAgLy8gUHJpb3JpdHkgaW5kaWNhdG9yXG4gICAgICAgIGNvbnN0IHByaW9yaXR5RG90ID0gY2FyZC5jcmVhdGVEaXYoeyBjbHM6IGB0YXNrLXByaW9yaXR5IHByaW9yaXR5LSR7dGFzay5wcmlvcml0eX1gIH0pO1xuICAgICAgICBwcmlvcml0eURvdC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIChlKSA9PiB7XG4gICAgICAgICAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgICAgICAgICAgdGhpcy5zaG93UHJpb3JpdHlNZW51KHRhc2ssIHByaW9yaXR5RG90LCBlKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gVGFzayB0aXRsZVxuICAgICAgICBjb25zdCB0aXRsZSA9IGNhcmQuY3JlYXRlRGl2KHsgY2xzOiAndGFzay10aXRsZScgfSk7XG4gICAgICAgIHRpdGxlLmNyZWF0ZUVsKCdhJywge1xuICAgICAgICAgICAgdGV4dDogdGFzay50aXRsZSxcbiAgICAgICAgICAgIGhyZWY6ICcjJyxcbiAgICAgICAgICAgIGNsczogJ3Rhc2stbGluaydcbiAgICAgICAgfSkuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoZSkgPT4ge1xuICAgICAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLm9wZW5MaW5rVGV4dCh0YXNrLmZpbGUucGF0aCwgJycpO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBUYXNrIG1ldGFcbiAgICAgICAgY29uc3QgbWV0YSA9IGNhcmQuY3JlYXRlRGl2KHsgY2xzOiAndGFzay1tZXRhJyB9KTtcblxuICAgICAgICAvLyBUYWdcbiAgICAgICAgaWYgKHRhc2sudGFnICYmIHRhc2sudGFnICE9PSAndW50YWdnZWQnKSB7XG4gICAgICAgICAgICBtZXRhLmNyZWF0ZVNwYW4oeyB0ZXh0OiB0YXNrLnRhZywgY2xzOiAndGFzay10YWcnIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gRm9sZGVyXG4gICAgICAgIG1ldGEuY3JlYXRlU3Bhbih7IHRleHQ6IHRhc2suZm9sZGVyLCBjbHM6ICd0YXNrLWZvbGRlcicgfSk7XG5cbiAgICAgICAgLy8gU3RhdHVzIGNoYW5nZSBvbiBjYXJkIGNsaWNrXG4gICAgICAgIGNhcmQuYWRkRXZlbnRMaXN0ZW5lcignY29udGV4dG1lbnUnLCAoZSkgPT4ge1xuICAgICAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICAgICAgdGhpcy5zaG93U3RhdHVzTWVudSh0YXNrLCBlKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gRHJhZyBzdXBwb3J0XG4gICAgICAgIGNhcmQuZHJhZ2dhYmxlID0gdHJ1ZTtcbiAgICAgICAgY2FyZC5hZGRFdmVudExpc3RlbmVyKCdkcmFnc3RhcnQnLCAoZSkgPT4ge1xuICAgICAgICAgICAgZS5kYXRhVHJhbnNmZXI/LnNldERhdGEoJ3RleHQvcGxhaW4nLCB0YXNrLmlkKTtcbiAgICAgICAgICAgIGUuZGF0YVRyYW5zZmVyPy5zZXREYXRhKCd0YXNrL3RhZycsIHRhc2sudGFnKTtcbiAgICAgICAgICAgIGUuZGF0YVRyYW5zZmVyPy5zZXREYXRhKCd0YXNrL2ZvbGRlcicsIHRhc2suZm9sZGVyKTtcbiAgICAgICAgICAgIGNhcmQuY2xhc3NMaXN0LmFkZCgnZHJhZ2dpbmcnKTtcbiAgICAgICAgfSk7XG4gICAgICAgIGNhcmQuYWRkRXZlbnRMaXN0ZW5lcignZHJhZ2VuZCcsICgpID0+IHtcbiAgICAgICAgICAgIGNhcmQuY2xhc3NMaXN0LnJlbW92ZSgnZHJhZ2dpbmcnKTtcbiAgICAgICAgICAgIC8vIFJlbW92ZSBhbGwgZHJvcC10YXJnZXQgaGlnaGxpZ2h0c1xuICAgICAgICAgICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRyb3AtdGFyZ2V0JykuZm9yRWFjaChlbCA9PiBlbC5jbGFzc0xpc3QucmVtb3ZlKCdkcm9wLXRhcmdldCcpKTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgc2hvd1ByaW9yaXR5TWVudSh0YXNrOiBUYXNrLCBlbGVtZW50OiBIVE1MRWxlbWVudCwgZXZ0OiBNb3VzZUV2ZW50KSB7XG4gICAgICAgIGNvbnN0IG1lbnUgPSBuZXcgTWVudSgpO1xuICAgICAgICBcbiAgICAgICAgY29uc3QgcHJpb3JpdGllcyA9IFsnaGlnaCcsICdtZWRpdW0nLCAnbG93J10gYXMgY29uc3Q7XG4gICAgICAgIGZvciAoY29uc3QgcHJpb3JpdHkgb2YgcHJpb3JpdGllcykge1xuICAgICAgICAgICAgbWVudS5hZGRJdGVtKChpdGVtKSA9PiB7XG4gICAgICAgICAgICAgICAgaXRlbS5zZXRUaXRsZShwcmlvcml0eS5jaGFyQXQoMCkudG9VcHBlckNhc2UoKSArIHByaW9yaXR5LnNsaWNlKDEpKVxuICAgICAgICAgICAgICAgICAgICAuc2V0SWNvbih0YXNrLnByaW9yaXR5ID09PSBwcmlvcml0eSA/ICdjaGVjaycgOiAnJylcbiAgICAgICAgICAgICAgICAgICAgLm9uQ2xpY2soYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4udXBkYXRlVGFza1ByaW9yaXR5KHRhc2ssIHByaW9yaXR5KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMucmVmcmVzaCgpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgbWVudS5zaG93QXRNb3VzZUV2ZW50KGV2dCk7XG4gICAgfVxuXG4gICAgc2hvd1N0YXR1c01lbnUodGFzazogVGFzaywgZXZ0OiBNb3VzZUV2ZW50KSB7XG4gICAgICAgIGNvbnN0IG1lbnUgPSBuZXcgTWVudSgpO1xuICAgICAgICBcbiAgICAgICAgZm9yIChjb25zdCBzdGF0dXMgb2YgdGhpcy5wbHVnaW4uc2V0dGluZ3Muc3RhdHVzT3JkZXIpIHtcbiAgICAgICAgICAgIG1lbnUuYWRkSXRlbSgoaXRlbSkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IGxhYmVsID0gdGhpcy5nZXRTdGF0dXNMYWJlbChzdGF0dXMpO1xuICAgICAgICAgICAgICAgIGl0ZW0uc2V0VGl0bGUobGFiZWwpXG4gICAgICAgICAgICAgICAgICAgIC5zZXRJY29uKHRhc2suc3RhdHVzID09PSBzdGF0dXMgPyAnY2hlY2snIDogJycpXG4gICAgICAgICAgICAgICAgICAgIC5vbkNsaWNrKGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnVwZGF0ZVRhc2tTdGF0dXModGFzaywgc3RhdHVzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMucmVmcmVzaCgpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgbWVudS5zaG93QXRNb3VzZUV2ZW50KGV2dCk7XG4gICAgfVxuXG4gICAgZ2V0U3RhdHVzTGFiZWwoc3RhdHVzOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgICAgICBjb25zdCBsYWJlbHM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgICAgICAgICAndG9kbyc6ICdUbyBEbycsXG4gICAgICAgICAgICAnaW4tcHJvZ3Jlc3MnOiAnSW4gUHJvZ3Jlc3MnLFxuICAgICAgICAgICAgJ2RvbmUnOiAnRG9uZScsXG4gICAgICAgICAgICAnYXJjaGl2ZSc6ICdBcmNoaXZlJ1xuICAgICAgICB9O1xuICAgICAgICByZXR1cm4gbGFiZWxzW3N0YXR1c10gfHwgc3RhdHVzLmNoYXJBdCgwKS50b1VwcGVyQ2FzZSgpICsgc3RhdHVzLnNsaWNlKDEpO1xuICAgIH1cblxuICAgIC8vIFNob3cgZGlhbG9nIHRvIGNyZWF0ZSBhIG5ldyB0YXNrIGluIGEgc3BlY2lmaWMgZm9sZGVyIGFuZCB0YWdcbiAgICBzaG93TmV3VGFza0RpYWxvZyhmb2xkZXJOYW1lOiBzdHJpbmcsIHRhZzogc3RyaW5nKSB7XG4gICAgICAgIGNvbnN0IG1vZGFsID0gbmV3IE5ld1Rhc2tNb2RhbCh0aGlzLmFwcCwgZm9sZGVyTmFtZSwgdGFnLCAodGl0bGUsIGZvbGRlciwgdGFza1RhZywgcHJpb3JpdHkpID0+IHtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLmNyZWF0ZU5ld1Rhc2sodGl0bGUsIGZvbGRlciwgdGFza1RhZywgcHJpb3JpdHkpO1xuICAgICAgICB9KTtcbiAgICAgICAgbW9kYWwub3BlbigpO1xuICAgIH1cblxuICAgIC8vIFNob3cgZGlhbG9nIHRvIGNyZWF0ZSBhIG5ldyB0YWcgd2l0aCBhIFRPRE8gaXRlbVxuICAgIHNob3dOZXdUYWdEaWFsb2coZm9sZGVyTmFtZTogc3RyaW5nKSB7XG4gICAgICAgIGNvbnN0IG1vZGFsID0gbmV3IE5ld1RhZ01vZGFsKHRoaXMuYXBwLCBmb2xkZXJOYW1lLCAodGFnTmFtZSwgdGl0bGUsIHByaW9yaXR5KSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5jcmVhdGVOZXdUYXNrKHRpdGxlLCBmb2xkZXJOYW1lLCB0YWdOYW1lLCBwcmlvcml0eSk7XG4gICAgICAgIH0pO1xuICAgICAgICBtb2RhbC5vcGVuKCk7XG4gICAgfVxufVxuXG4vLyBNb2RhbCBmb3IgY3JlYXRpbmcgYSBuZXcgdGFza1xuY2xhc3MgTmV3VGFza01vZGFsIGV4dGVuZHMgTW9kYWwge1xuICAgIGZvbGRlcjogc3RyaW5nO1xuICAgIHRhZzogc3RyaW5nO1xuICAgIG9uU3VibWl0OiAodGl0bGU6IHN0cmluZywgZm9sZGVyOiBzdHJpbmcsIHRhZzogc3RyaW5nLCBwcmlvcml0eTogc3RyaW5nKSA9PiB2b2lkO1xuXG4gICAgY29uc3RydWN0b3IoYXBwOiBBcHAsIGZvbGRlcjogc3RyaW5nLCB0YWc6IHN0cmluZywgb25TdWJtaXQ6ICh0aXRsZTogc3RyaW5nLCBmb2xkZXI6IHN0cmluZywgdGFnOiBzdHJpbmcsIHByaW9yaXR5OiBzdHJpbmcpID0+IHZvaWQpIHtcbiAgICAgICAgc3VwZXIoYXBwKTtcbiAgICAgICAgdGhpcy5mb2xkZXIgPSBmb2xkZXI7XG4gICAgICAgIHRoaXMudGFnID0gdGFnO1xuICAgICAgICB0aGlzLm9uU3VibWl0ID0gb25TdWJtaXQ7XG4gICAgfVxuXG4gICAgb25PcGVuKCkge1xuICAgICAgICBjb25zdCB7IGNvbnRlbnRFbCB9ID0gdGhpcztcbiAgICAgICAgY29udGVudEVsLmNyZWF0ZUVsKCdoMicsIHsgdGV4dDogJ0NyZWF0ZSBOZXcgVGFzaycgfSk7XG5cbiAgICAgICAgLy8gVGl0bGUgaW5wdXRcbiAgICAgICAgY29udGVudEVsLmNyZWF0ZUVsKCdsYWJlbCcsIHsgdGV4dDogJ1Rhc2sgVGl0bGU6JyB9KTtcbiAgICAgICAgY29uc3QgdGl0bGVJbnB1dCA9IGNvbnRlbnRFbC5jcmVhdGVFbCgnaW5wdXQnLCB7XG4gICAgICAgICAgICB0eXBlOiAndGV4dCcsXG4gICAgICAgICAgICBwbGFjZWhvbGRlcjogJ0VudGVyIHRhc2sgdGl0bGUuLi4nXG4gICAgICAgIH0pO1xuICAgICAgICB0aXRsZUlucHV0LnN0eWxlLndpZHRoID0gJzEwMCUnO1xuICAgICAgICB0aXRsZUlucHV0LnN0eWxlLm1hcmdpbkJvdHRvbSA9ICcxNnB4JztcblxuICAgICAgICAvLyBGb2xkZXIgaW5mb1xuICAgICAgICBjb250ZW50RWwuY3JlYXRlRWwoJ2xhYmVsJywgeyB0ZXh0OiAnRm9sZGVyOicgfSk7XG4gICAgICAgIGNvbnRlbnRFbC5jcmVhdGVFbCgnZGl2JywgeyB0ZXh0OiB0aGlzLmZvbGRlciwgY2xzOiAnbmV3LXRhc2staW5mbycgfSk7XG5cbiAgICAgICAgLy8gVGFnIGluZm9cbiAgICAgICAgY29udGVudEVsLmNyZWF0ZUVsKCdsYWJlbCcsIHsgdGV4dDogJ1RhZzonIH0pO1xuICAgICAgICBjb250ZW50RWwuY3JlYXRlRWwoJ2RpdicsIHsgdGV4dDogdGhpcy50YWcsIGNsczogJ25ldy10YXNrLWluZm8nIH0pO1xuXG4gICAgICAgIC8vIFByaW9yaXR5IHNlbGVjdGlvblxuICAgICAgICBjb250ZW50RWwuY3JlYXRlRWwoJ2xhYmVsJywgeyB0ZXh0OiAnUHJpb3JpdHk6JyB9KTtcbiAgICAgICAgY29uc3QgcHJpb3JpdHlTZWxlY3QgPSBjb250ZW50RWwuY3JlYXRlRWwoJ3NlbGVjdCcpO1xuICAgICAgICBwcmlvcml0eVNlbGVjdC5zdHlsZS53aWR0aCA9ICcxMDAlJztcbiAgICAgICAgcHJpb3JpdHlTZWxlY3Quc3R5bGUubWFyZ2luQm90dG9tID0gJzE2cHgnO1xuICAgICAgICBbJ2hpZ2gnLCAnbWVkaXVtJywgJ2xvdyddLmZvckVhY2gocCA9PiB7XG4gICAgICAgICAgICBjb25zdCBvcHRpb24gPSBwcmlvcml0eVNlbGVjdC5jcmVhdGVFbCgnb3B0aW9uJywgeyB0ZXh0OiBwLCB2YWx1ZTogcCB9KTtcbiAgICAgICAgICAgIGlmIChwID09PSAnbWVkaXVtJykgb3B0aW9uLnNlbGVjdGVkID0gdHJ1ZTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gQnV0dG9uc1xuICAgICAgICBjb25zdCBidXR0b25Db250YWluZXIgPSBjb250ZW50RWwuY3JlYXRlRGl2KHsgY2xzOiAnbW9kYWwtYnV0dG9uLWNvbnRhaW5lcicgfSk7XG5cbiAgICAgICAgY29uc3Qgc3VibWl0QnRuID0gYnV0dG9uQ29udGFpbmVyLmNyZWF0ZUVsKCdidXR0b24nLCB7XG4gICAgICAgICAgICB0ZXh0OiAnQ3JlYXRlJyxcbiAgICAgICAgICAgIGNsczogJ21vZC1jdGEnXG4gICAgICAgIH0pO1xuICAgICAgICBzdWJtaXRCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCB0aXRsZSA9IHRpdGxlSW5wdXQudmFsdWUudHJpbSgpO1xuICAgICAgICAgICAgaWYgKHRpdGxlKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5vblN1Ym1pdCh0aXRsZSwgdGhpcy5mb2xkZXIsIHRoaXMudGFnLCBwcmlvcml0eVNlbGVjdC52YWx1ZSk7XG4gICAgICAgICAgICAgICAgdGhpcy5jbG9zZSgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBjb25zdCBjYW5jZWxCdG4gPSBidXR0b25Db250YWluZXIuY3JlYXRlRWwoJ2J1dHRvbicsIHsgdGV4dDogJ0NhbmNlbCcgfSk7XG4gICAgICAgIGNhbmNlbEJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHRoaXMuY2xvc2UoKSk7XG5cbiAgICAgICAgLy8gRm9jdXMgdGl0bGUgaW5wdXRcbiAgICAgICAgdGl0bGVJbnB1dC5mb2N1cygpO1xuICAgIH1cblxuICAgIG9uQ2xvc2UoKSB7XG4gICAgICAgIGNvbnN0IHsgY29udGVudEVsIH0gPSB0aGlzO1xuICAgICAgICBjb250ZW50RWwuZW1wdHkoKTtcbiAgICB9XG59XG5cbi8vIE1vZGFsIGZvciBjcmVhdGluZyBhIG5ldyB0YWdcbmNsYXNzIE5ld1RhZ01vZGFsIGV4dGVuZHMgTW9kYWwge1xuICAgIGZvbGRlcjogc3RyaW5nO1xuICAgIG9uU3VibWl0OiAodGFnTmFtZTogc3RyaW5nLCB0aXRsZTogc3RyaW5nLCBwcmlvcml0eTogc3RyaW5nKSA9PiB2b2lkO1xuXG4gICAgY29uc3RydWN0b3IoYXBwOiBBcHAsIGZvbGRlcjogc3RyaW5nLCBvblN1Ym1pdDogKHRhZ05hbWU6IHN0cmluZywgdGl0bGU6IHN0cmluZywgcHJpb3JpdHk6IHN0cmluZykgPT4gdm9pZCkge1xuICAgICAgICBzdXBlcihhcHApO1xuICAgICAgICB0aGlzLmZvbGRlciA9IGZvbGRlcjtcbiAgICAgICAgdGhpcy5vblN1Ym1pdCA9IG9uU3VibWl0O1xuICAgIH1cblxuICAgIG9uT3BlbigpIHtcbiAgICAgICAgY29uc3QgeyBjb250ZW50RWwgfSA9IHRoaXM7XG4gICAgICAgIGNvbnRlbnRFbC5jcmVhdGVFbCgnaDInLCB7IHRleHQ6ICdDcmVhdGUgTmV3IFRhZyB3aXRoIFRhc2snIH0pO1xuXG4gICAgICAgIC8vIFRhZyBuYW1lIGlucHV0XG4gICAgICAgIGNvbnRlbnRFbC5jcmVhdGVFbCgnbGFiZWwnLCB7IHRleHQ6ICdUYWcgTmFtZTonIH0pO1xuICAgICAgICBjb25zdCB0YWdJbnB1dCA9IGNvbnRlbnRFbC5jcmVhdGVFbCgnaW5wdXQnLCB7XG4gICAgICAgICAgICB0eXBlOiAndGV4dCcsXG4gICAgICAgICAgICBwbGFjZWhvbGRlcjogJ0VudGVyIG5ldyB0YWcgbmFtZS4uLidcbiAgICAgICAgfSk7XG4gICAgICAgIHRhZ0lucHV0LnN0eWxlLndpZHRoID0gJzEwMCUnO1xuICAgICAgICB0YWdJbnB1dC5zdHlsZS5tYXJnaW5Cb3R0b20gPSAnMTZweCc7XG5cbiAgICAgICAgLy8gVGFzayB0aXRsZSBpbnB1dFxuICAgICAgICBjb250ZW50RWwuY3JlYXRlRWwoJ2xhYmVsJywgeyB0ZXh0OiAnVGFzayBUaXRsZTonIH0pO1xuICAgICAgICBjb25zdCB0aXRsZUlucHV0ID0gY29udGVudEVsLmNyZWF0ZUVsKCdpbnB1dCcsIHtcbiAgICAgICAgICAgIHR5cGU6ICd0ZXh0JyxcbiAgICAgICAgICAgIHBsYWNlaG9sZGVyOiAnRW50ZXIgdGFzayB0aXRsZS4uLidcbiAgICAgICAgfSk7XG4gICAgICAgIHRpdGxlSW5wdXQuc3R5bGUud2lkdGggPSAnMTAwJSc7XG4gICAgICAgIHRpdGxlSW5wdXQuc3R5bGUubWFyZ2luQm90dG9tID0gJzE2cHgnO1xuXG4gICAgICAgIC8vIEZvbGRlciBpbmZvXG4gICAgICAgIGNvbnRlbnRFbC5jcmVhdGVFbCgnbGFiZWwnLCB7IHRleHQ6ICdGb2xkZXI6JyB9KTtcbiAgICAgICAgY29udGVudEVsLmNyZWF0ZUVsKCdkaXYnLCB7IHRleHQ6IHRoaXMuZm9sZGVyLCBjbHM6ICduZXctdGFzay1pbmZvJyB9KTtcblxuICAgICAgICAvLyBQcmlvcml0eSBzZWxlY3Rpb25cbiAgICAgICAgY29udGVudEVsLmNyZWF0ZUVsKCdsYWJlbCcsIHsgdGV4dDogJ1ByaW9yaXR5OicgfSk7XG4gICAgICAgIGNvbnN0IHByaW9yaXR5U2VsZWN0ID0gY29udGVudEVsLmNyZWF0ZUVsKCdzZWxlY3QnKTtcbiAgICAgICAgcHJpb3JpdHlTZWxlY3Quc3R5bGUud2lkdGggPSAnMTAwJSc7XG4gICAgICAgIHByaW9yaXR5U2VsZWN0LnN0eWxlLm1hcmdpbkJvdHRvbSA9ICcxNnB4JztcbiAgICAgICAgWydoaWdoJywgJ21lZGl1bScsICdsb3cnXS5mb3JFYWNoKHAgPT4ge1xuICAgICAgICAgICAgY29uc3Qgb3B0aW9uID0gcHJpb3JpdHlTZWxlY3QuY3JlYXRlRWwoJ29wdGlvbicsIHsgdGV4dDogcCwgdmFsdWU6IHAgfSk7XG4gICAgICAgICAgICBpZiAocCA9PT0gJ21lZGl1bScpIG9wdGlvbi5zZWxlY3RlZCA9IHRydWU7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIEJ1dHRvbnNcbiAgICAgICAgY29uc3QgYnV0dG9uQ29udGFpbmVyID0gY29udGVudEVsLmNyZWF0ZURpdih7IGNsczogJ21vZGFsLWJ1dHRvbi1jb250YWluZXInIH0pO1xuXG4gICAgICAgIGNvbnN0IHN1Ym1pdEJ0biA9IGJ1dHRvbkNvbnRhaW5lci5jcmVhdGVFbCgnYnV0dG9uJywge1xuICAgICAgICAgICAgdGV4dDogJ0NyZWF0ZScsXG4gICAgICAgICAgICBjbHM6ICdtb2QtY3RhJ1xuICAgICAgICB9KTtcbiAgICAgICAgc3VibWl0QnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICAgICAgY29uc3QgdGFnTmFtZSA9IHRhZ0lucHV0LnZhbHVlLnRyaW0oKS50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1xccysvZywgJy0nKTtcbiAgICAgICAgICAgIGNvbnN0IHRpdGxlID0gdGl0bGVJbnB1dC52YWx1ZS50cmltKCk7XG4gICAgICAgICAgICBpZiAodGFnTmFtZSAmJiB0aXRsZSkge1xuICAgICAgICAgICAgICAgIHRoaXMub25TdWJtaXQodGFnTmFtZSwgdGl0bGUsIHByaW9yaXR5U2VsZWN0LnZhbHVlKTtcbiAgICAgICAgICAgICAgICB0aGlzLmNsb3NlKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGNvbnN0IGNhbmNlbEJ0biA9IGJ1dHRvbkNvbnRhaW5lci5jcmVhdGVFbCgnYnV0dG9uJywgeyB0ZXh0OiAnQ2FuY2VsJyB9KTtcbiAgICAgICAgY2FuY2VsQnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdGhpcy5jbG9zZSgpKTtcblxuICAgICAgICAvLyBGb2N1cyB0YWcgaW5wdXRcbiAgICAgICAgdGFnSW5wdXQuZm9jdXMoKTtcbiAgICB9XG5cbiAgICBvbkNsb3NlKCkge1xuICAgICAgICBjb25zdCB7IGNvbnRlbnRFbCB9ID0gdGhpcztcbiAgICAgICAgY29udGVudEVsLmVtcHR5KCk7XG4gICAgfVxufVxuXG4vLyBTZXR0aW5ncyBUYWJcbmNsYXNzIFRhc2tCb2FyZFNldHRpbmdUYWIgZXh0ZW5kcyBQbHVnaW5TZXR0aW5nVGFiIHtcbiAgICBwbHVnaW46IFRhc2tCb2FyZFBsdWdpbjtcblxuICAgIGNvbnN0cnVjdG9yKGFwcDogQXBwLCBwbHVnaW46IFRhc2tCb2FyZFBsdWdpbikge1xuICAgICAgICBzdXBlcihhcHAsIHBsdWdpbik7XG4gICAgICAgIHRoaXMucGx1Z2luID0gcGx1Z2luO1xuICAgIH1cblxuICAgIGRpc3BsYXkoKTogdm9pZCB7XG4gICAgICAgIGNvbnN0IHsgY29udGFpbmVyRWwgfSA9IHRoaXM7XG4gICAgICAgIGNvbnRhaW5lckVsLmVtcHR5KCk7XG5cbiAgICAgICAgY29udGFpbmVyRWwuY3JlYXRlRWwoJ2gyJywgeyB0ZXh0OiAnVGFzayBCb2FyZCBTZXR0aW5ncycgfSk7XG5cbiAgICAgICAgLy8gVGFzayBmb2xkZXJzXG4gICAgICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgICAgICAgLnNldE5hbWUoJ1Rhc2sgZm9sZGVyIG5hbWVzJylcbiAgICAgICAgICAgIC5zZXREZXNjKCdOYW1lcyBvZiBmb2xkZXJzIHRoYXQgY29udGFpbiB0YXNrcyAoY29tbWEtc2VwYXJhdGVkKS4gV2lsbCBzZWFyY2ggaW4gc3ViZm9sZGVycyByZWN1cnNpdmVseS4nKVxuICAgICAgICAgICAgLmFkZFRleHQodGV4dCA9PiB0ZXh0XG4gICAgICAgICAgICAgICAgLnNldFBsYWNlaG9sZGVyKCd0YXNrcywgdG9kbywgaXNzdWVzJylcbiAgICAgICAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MudGFza0ZvbGRlcnMuam9pbignLCAnKSlcbiAgICAgICAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLnRhc2tGb2xkZXJzID0gdmFsdWVcbiAgICAgICAgICAgICAgICAgICAgICAgIC5zcGxpdCgnLCcpXG4gICAgICAgICAgICAgICAgICAgICAgICAubWFwKHMgPT4gcy50cmltKCkpXG4gICAgICAgICAgICAgICAgICAgICAgICAuZmlsdGVyKHMgPT4gcy5sZW5ndGggPiAwKTtcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgICAgICAgfSkpO1xuXG4gICAgICAgIC8vIFN0YXR1cyBvcmRlclxuICAgICAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgICAgICAgIC5zZXROYW1lKCdTdGF0dXMgY29sdW1ucycpXG4gICAgICAgICAgICAuc2V0RGVzYygnT3JkZXIgb2Ygc3RhdHVzIGNvbHVtbnMgKGNvbW1hLXNlcGFyYXRlZCknKVxuICAgICAgICAgICAgLmFkZFRleHQodGV4dCA9PiB0ZXh0XG4gICAgICAgICAgICAgICAgLnNldFBsYWNlaG9sZGVyKCd0b2RvLCBpbi1wcm9ncmVzcywgZG9uZSwgYXJjaGl2ZScpXG4gICAgICAgICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLnN0YXR1c09yZGVyLmpvaW4oJywgJykpXG4gICAgICAgICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zdGF0dXNPcmRlciA9IHZhbHVlXG4gICAgICAgICAgICAgICAgICAgICAgICAuc3BsaXQoJywnKVxuICAgICAgICAgICAgICAgICAgICAgICAgLm1hcChzID0+IHMudHJpbSgpKVxuICAgICAgICAgICAgICAgICAgICAgICAgLmZpbHRlcihzID0+IHMubGVuZ3RoID4gMCk7XG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgICAgIH0pKTtcblxuICAgICAgICAvLyBEZWZhdWx0IHN0YXR1c1xuICAgICAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgICAgICAgIC5zZXROYW1lKCdEZWZhdWx0IHN0YXR1cycpXG4gICAgICAgICAgICAuc2V0RGVzYygnRGVmYXVsdCBzdGF0dXMgZm9yIHRhc2tzIHdpdGhvdXQgZnJvbnRtYXR0ZXInKVxuICAgICAgICAgICAgLmFkZFRleHQodGV4dCA9PiB0ZXh0XG4gICAgICAgICAgICAgICAgLnNldFBsYWNlaG9sZGVyKCd0b2RvJylcbiAgICAgICAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuZGVmYXVsdFN0YXR1cylcbiAgICAgICAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLmRlZmF1bHRTdGF0dXMgPSB2YWx1ZS50cmltKCkgfHwgJ3RvZG8nO1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICAgICAgICB9KSk7XG4gICAgfVxufVxuIl19