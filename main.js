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
        this.filteredTasks = [];
        this.selectedTags = new Set();
        this.tagFilterContainer = null;
        this.hiddenStatuses = new Set();
        this.searchQuery = '';
        this.searchInput = null;
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
        this.applyFilters();
        this.render();
    }
    // Apply search and tag filters to tasks
    applyFilters() {
        let result = this.tasks;
        // Apply search query filter
        if (this.searchQuery.trim()) {
            const query = this.searchQuery.toLowerCase();
            result = result.filter(task => {
                const titleMatch = task.title.toLowerCase().includes(query);
                const tagMatch = task.tag.toLowerCase().includes(query);
                const contentMatch = task.content.toLowerCase().includes(query);
                return titleMatch || tagMatch || contentMatch;
            });
        }
        // Apply tag filter (only if not all tags selected)
        const allTags = this.getAllTags();
        if (this.selectedTags.size > 0 && this.selectedTags.size < allTags.length) {
            result = result.filter(task => this.selectedTags.has(task.tag));
        }
        this.filteredTasks = result;
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
        // Search bar
        const searchContainer = header.createDiv({ cls: 'task-search-container' });
        const searchInput = searchContainer.createEl('input', {
            type: 'text',
            placeholder: 'Search tasks...',
            cls: 'task-search-input'
        });
        searchInput.value = this.searchQuery;
        // Search icon
        const searchIcon = searchContainer.createSpan({ cls: 'task-search-icon', text: '🔍' });
        // Real-time search with minimal debounce
        let debounceTimer;
        searchInput.addEventListener('input', (e) => {
            clearTimeout(debounceTimer);
            this.searchQuery = searchInput.value;
            this.applyFilters();
            this.renderBoard();
        });
        // Clear button (visible when search has text)
        if (this.searchQuery) {
            const clearSearchBtn = searchContainer.createEl('button', {
                cls: 'task-search-clear',
                text: '✕'
            });
            clearSearchBtn.addEventListener('click', () => {
                this.searchQuery = '';
                this.applyFilters();
                this.render();
            });
        }
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
                this.applyFilters();
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
        // Use pre-filtered tasks (search + tag filters already applied)
        const tasksToRender = this.filteredTasks;
        // Group tasks by status
        const tasksByStatus = new Map();
        // Initialize with configured status order
        for (const status of this.plugin.settings.statusOrder) {
            tasksByStatus.set(status, []);
        }
        // Group tasks
        for (const task of tasksToRender) {
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
        // Drag support (desktop only - HTML5 drag doesn't work well on mobile)
        const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
        if (!isMobile) {
            card.draggable = true;
            card.addEventListener('dragstart', (e) => {
                e.dataTransfer?.setData('text/plain', task.id);
                e.dataTransfer?.setData('task/tag', task.tag);
                e.dataTransfer?.setData('task/folder', task.folder);
                card.classList.add('dragging');
            });
            card.addEventListener('dragend', () => {
                card.classList.remove('dragging');
                // Remove all drop-target highlights (safely)
                try {
                    if (typeof document !== 'undefined') {
                        document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
                    }
                }
                catch (e) {
                    // Ignore document errors on mobile
                }
            });
        }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1haW4udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSx1Q0FpQmtCO0FBeUJsQixNQUFNLGdCQUFnQixHQUFzQjtJQUN4QyxXQUFXLEVBQUUsQ0FBQyxPQUFPLENBQUM7SUFDdEIsV0FBVyxFQUFFLENBQUMsTUFBTSxFQUFFLGFBQWEsRUFBRSxNQUFNLEVBQUUsU0FBUyxDQUFDO0lBQ3ZELGFBQWEsRUFBRSxNQUFNO0lBQ3JCLE1BQU0sRUFBRSxVQUFVO0lBQ2xCLGFBQWEsRUFBRSxNQUFNO0lBQ3JCLGFBQWEsRUFBRSxLQUFLO0lBQ3BCLGNBQWMsRUFBRSxFQUFFO0NBQ3JCLENBQUM7QUFFRixNQUFNLG9CQUFvQixHQUFHLGlCQUFpQixDQUFDO0FBRS9DLG9CQUFvQjtBQUNwQixNQUFxQixlQUFnQixTQUFRLGlCQUFNO0lBRy9DLEtBQUssQ0FBQyxNQUFNO1FBQ1IsTUFBTSxJQUFJLENBQUMsWUFBWSxFQUFFLENBQUM7UUFFMUIsMkJBQTJCO1FBQzNCLElBQUksQ0FBQyxZQUFZLENBQ2Isb0JBQW9CLEVBQ3BCLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxJQUFJLGFBQWEsQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLENBQzFDLENBQUM7UUFFRixrQkFBa0I7UUFDbEIsSUFBSSxDQUFDLGFBQWEsQ0FBQyxjQUFjLEVBQUUsaUJBQWlCLEVBQUUsR0FBRyxFQUFFO1lBQ3ZELElBQUksQ0FBQyxZQUFZLEVBQUUsQ0FBQztRQUN4QixDQUFDLENBQUMsQ0FBQztRQUVILGdDQUFnQztRQUNoQyxJQUFJLENBQUMsVUFBVSxDQUFDO1lBQ1osRUFBRSxFQUFFLGlCQUFpQjtZQUNyQixJQUFJLEVBQUUsaUJBQWlCO1lBQ3ZCLFFBQVEsRUFBRSxHQUFHLEVBQUU7Z0JBQ1gsSUFBSSxDQUFDLFlBQVksRUFBRSxDQUFDO1lBQ3hCLENBQUM7U0FDSixDQUFDLENBQUM7UUFFSCxzQ0FBc0M7UUFDdEMs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TSxDQUFDO1lBQzVELE1BQU0sSUFBSSxDQUFDLE1BQU0sQ0FBQyxZQUFZLEVBQUUsQ0FBQztRQUNyQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ2hCLENBQUM7Q0FDSiIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7XG4gICAgQXBwLFxuICAgIFBsdWdpbixcbiAgICBQbHVnaW5TZXR0aW5nVGFiLFxuICAgIFNldHRpbmcsXG4gICAgVEZpbGUsXG4gICAgVEZvbGRlcixcbiAgICBJdGVtVmlldyxcbiAgICBXb3Jrc3BhY2VMZWFmLFxuICAgIE5vdGljZSxcbiAgICBNZW51LFxuICAgIFRleHRDb21wb25lbnQsXG4gICAgRHJvcGRvd25Db21wb25lbnQsXG4gICAgQnV0dG9uQ29tcG9uZW50LFxuICAgIE1hcmtkb3duUmVuZGVyZXIsXG4gICAgQ29tcG9uZW50LFxuICAgIE1vZGFsXG59IGZyb20gJ29ic2lkaWFuJztcblxuLy8gVGFzayBpbnRlcmZhY2VcbmludGVyZmFjZSBUYXNrIHtcbiAgICBpZDogc3RyaW5nO1xuICAgIGZpbGU6IFRGaWxlO1xuICAgIHRpdGxlOiBzdHJpbmc7XG4gICAgc3RhdHVzOiBzdHJpbmc7XG4gICAgdGFnOiBzdHJpbmc7XG4gICAgcHJpb3JpdHk6ICdoaWdoJyB8ICdtZWRpdW0nIHwgJ2xvdyc7XG4gICAgY29udGVudDogc3RyaW5nO1xuICAgIGZvbGRlcjogc3RyaW5nO1xufVxuXG4vLyBQbHVnaW4gc2V0dGluZ3NcbmludGVyZmFjZSBUYXNrQm9hcmRTZXR0aW5ncyB7XG4gICAgdGFza0ZvbGRlcnM6IHN0cmluZ1tdO1xuICAgIHN0YXR1c09yZGVyOiBzdHJpbmdbXTtcbiAgICBkZWZhdWx0U3RhdHVzOiBzdHJpbmc7XG4gICAgc29ydEJ5OiAncHJpb3JpdHknIHwgJ3RhZycgfCAndGl0bGUnIHwgJ2ZvbGRlcic7XG4gICAgc29ydERpcmVjdGlvbjogJ2FzYycgfCAnZGVzYyc7XG4gICAgb3JnYW5pemVCeVRhZzogYm9vbGVhbjtcbiAgICBoaWRkZW5TdGF0dXNlczogc3RyaW5nW107XG59XG5cbmNvbnN0IERFRkFVTFRfU0VUVElOR1M6IFRhc2tCb2FyZFNldHRpbmdzID0ge1xuICAgIHRhc2tGb2xkZXJzOiBbJ3Rhc2tzJ10sXG4gICAgc3RhdHVzT3JkZXI6IFsndG9kbycsICdpbi1wcm9ncmVzcycsICdkb25lJywgJ2FyY2hpdmUnXSxcbiAgICBkZWZhdWx0U3RhdHVzOiAndG9kbycsXG4gICAgc29ydEJ5OiAncHJpb3JpdHknLFxuICAgIHNvcnREaXJlY3Rpb246ICdkZXNjJyxcbiAgICBvcmdhbml6ZUJ5VGFnOiBmYWxzZSxcbiAgICBoaWRkZW5TdGF0dXNlczogW11cbn07XG5cbmNvbnN0IFZJRVdfVFlQRV9UQVNLX0JPQVJEID0gJ3Rhc2stYm9hcmQtdmlldyc7XG5cbi8vIE1haW4gUGx1Z2luIENsYXNzXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBUYXNrQm9hcmRQbHVnaW4gZXh0ZW5kcyBQbHVnaW4ge1xuICAgIHNldHRpbmdzOiBUYXNrQm9hcmRTZXR0aW5ncztcblxuICAgIGFzeW5jIG9ubG9hZCgpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5sb2FkU2V0dGluZ3MoKTtcblxuICAgICAgICAvLyBSZWdpc3RlciB0aGUgY3VzdG9tIHZpZXdcbiAgICAgICAgdGhpcy5yZWdpc3RlclZpZXcoXG4gICAgICAgICAgICBWSUVXX1RZUEVfVEFTS19CT0FSRCxcbiAgICAgICAgICAgIChsZWFmKSA9PiBuZXcgVGFza0JvYXJkVmlldyhsZWFmLCB0aGlzKVxuICAgICAgICApO1xuXG4gICAgICAgIC8vIEFkZCByaWJib24gaWNvblxuICAgICAgICB0aGlzLmFkZFJpYmJvbkljb24oJ2xheW91dC1ib2FyZCcsICdPcGVuIFRhc2sgQm9hcmQnLCAoKSA9PiB7XG4gICAgICAgICAgICB0aGlzLmFjdGl2YXRlVmlldygpO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBBZGQgY29tbWFuZCAtIE9wZW4gVGFzayBCb2FyZFxuICAgICAgICB0aGlzLmFkZENvbW1hbmQoe1xuICAgICAgICAgICAgaWQ6ICdvcGVuLXRhc2stYm9hcmQnLFxuICAgICAgICAgICAgbmFtZTogJ09wZW4gVGFzayBCb2FyZCcsXG4gICAgICAgICAgICBjYWxsYmFjazogKCkgPT4ge1xuICAgICAgICAgICAgICAgIHRoaXMuYWN0aXZhdGVWaWV3KCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIEFkZCBjb21tYW5kIC0gT3JnYW5pemUgdGFza3MgYnkgdGFnXG4gICAgICAgIHRoaXMuYWRkQ29tbWFuZCh7XG4gICAgICAgICAgICBpZDogJ29yZ2FuaXplLXRhc2tzLWJ5LXRhZycsXG4gICAgICAgICAgICBuYW1lOiAnT3JnYW5pemUgdGFza3MgYnkgdGFnJyxcbiAgICAgICAgICAgIGNhbGxiYWNrOiBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5vcmdhbml6ZVRhc2tzQnlUYWcoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gQWRkIGNvbW1hbmQgLSBPcmdhbml6ZSB0YXNrcyBpbiBjdXJyZW50IGZvbGRlclxuICAgICAgICB0aGlzLmFkZENvbW1hbmQoe1xuICAgICAgICAgICAgaWQ6ICdvcmdhbml6ZS10YXNrcy1pbi1jdXJyZW50LWZvbGRlcicsXG4gICAgICAgICAgICBuYW1lOiAnT3JnYW5pemUgdGFza3MgaW4gY3VycmVudCBmb2xkZXIgYnkgdGFnJyxcbiAgICAgICAgICAgIGNoZWNrQ2FsbGJhY2s6IChjaGVja2luZzogYm9vbGVhbikgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IGZpbGUgPSB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0QWN0aXZlRmlsZSgpO1xuICAgICAgICAgICAgICAgIGlmIChmaWxlKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghY2hlY2tpbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGZvbGRlciA9IGZpbGUucGFyZW50O1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZvbGRlcikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMub3JnYW5pemVUYXNrc0luRm9sZGVyKGZvbGRlcik7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gQWRkIHNldHRpbmdzIHRhYlxuICAgICAgICB0aGlzLmFkZFNldHRpbmdUYWIobmV3IFRhc2tCb2FyZFNldHRpbmdUYWIodGhpcy5hcHAsIHRoaXMpKTtcblxuICAgICAgICAvLyBSZWZyZXNoIHZpZXcgd2hlbiBmaWxlcyBjaGFuZ2VcbiAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KFxuICAgICAgICAgICAgdGhpcy5hcHAudmF1bHQub24oJ2NyZWF0ZScsICgpID0+IHRoaXMucmVmcmVzaFZpZXcoKSlcbiAgICAgICAgKTtcbiAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KFxuICAgICAgICAgICAgdGhpcy5hcHAudmF1bHQub24oJ2RlbGV0ZScsICgpID0+IHRoaXMucmVmcmVzaFZpZXcoKSlcbiAgICAgICAgKTtcbiAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KFxuICAgICAgICAgICAgdGhpcy5hcHAudmF1bHQub24oJ3JlbmFtZScsICgpID0+IHRoaXMucmVmcmVzaFZpZXcoKSlcbiAgICAgICAgKTtcbiAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KFxuICAgICAgICAgICAgdGhpcy5hcHAubWV0YWRhdGFDYWNoZS5vbignY2hhbmdlZCcsICgpID0+IHRoaXMucmVmcmVzaFZpZXcoKSlcbiAgICAgICAgKTtcbiAgICB9XG5cbiAgICBvbnVubG9hZCgpIHtcbiAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLmRldGFjaExlYXZlc09mVHlwZShWSUVXX1RZUEVfVEFTS19CT0FSRCk7XG4gICAgfVxuXG4gICAgYXN5bmMgbG9hZFNldHRpbmdzKCkge1xuICAgICAgICB0aGlzLnNldHRpbmdzID0gT2JqZWN0LmFzc2lnbih7fSwgREVGQVVMVF9TRVRUSU5HUywgYXdhaXQgdGhpcy5sb2FkRGF0YSgpKTtcbiAgICB9XG5cbiAgICBhc3luYyBzYXZlU2V0dGluZ3MoKSB7XG4gICAgICAgIGF3YWl0IHRoaXMuc2F2ZURhdGEodGhpcy5zZXR0aW5ncyk7XG4gICAgICAgIHRoaXMucmVmcmVzaFZpZXcoKTtcbiAgICB9XG5cbiAgICBhc3luYyBhY3RpdmF0ZVZpZXcoKSB7XG4gICAgICAgIGNvbnN0IHsgd29ya3NwYWNlIH0gPSB0aGlzLmFwcDtcblxuICAgICAgICBsZXQgbGVhZjogV29ya3NwYWNlTGVhZiB8IG51bGwgPSBudWxsO1xuICAgICAgICBjb25zdCBsZWF2ZXMgPSB3b3Jrc3BhY2UuZ2V0TGVhdmVzT2ZUeXBlKFZJRVdfVFlQRV9UQVNLX0JPQVJEKTtcblxuICAgICAgICBpZiAobGVhdmVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGxlYWYgPSBsZWF2ZXNbMF07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyBDcmVhdGUgaW4gbWFpbiB2aWV3IGFyZWEgaW5zdGVhZCBvZiBzaWRlYmFyXG4gICAgICAgICAgICBsZWFmID0gd29ya3NwYWNlLmdldExlYWYoJ3RhYicpO1xuICAgICAgICAgICAgYXdhaXQgbGVhZi5zZXRWaWV3U3RhdGUoeyB0eXBlOiBWSUVXX1RZUEVfVEFTS19CT0FSRCwgYWN0aXZlOiB0cnVlIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgd29ya3NwYWNlLnJldmVhbExlYWYobGVhZik7XG4gICAgfVxuXG4gICAgcmVmcmVzaFZpZXcoKSB7XG4gICAgICAgIGNvbnN0IGxlYXZlcyA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRMZWF2ZXNPZlR5cGUoVklFV19UWVBFX1RBU0tfQk9BUkQpO1xuICAgICAgICBmb3IgKGNvbnN0IGxlYWYgb2YgbGVhdmVzKSB7XG4gICAgICAgICAgICBjb25zdCB2aWV3ID0gbGVhZi52aWV3IGFzIFRhc2tCb2FyZFZpZXc7XG4gICAgICAgICAgICB2aWV3LnJlZnJlc2goKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIFJlY3Vyc2l2ZWx5IGNvbGxlY3QgYWxsIG1hcmtkb3duIGZpbGVzIGZyb20gYSBmb2xkZXIgYW5kIGl0cyBzdWJmb2xkZXJzXG4gICAgcHJpdmF0ZSBjb2xsZWN0TWFya2Rvd25GaWxlcyhmb2xkZXI6IFRGb2xkZXIpOiBURmlsZVtdIHtcbiAgICAgICAgY29uc3QgZmlsZXM6IFRGaWxlW10gPSBbXTtcbiAgICAgICAgXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgZm9sZGVyLmNoaWxkcmVuKSB7XG4gICAgICAgICAgICBpZiAoY2hpbGQgaW5zdGFuY2VvZiBURmlsZSAmJiBjaGlsZC5leHRlbnNpb24gPT09ICdtZCcpIHtcbiAgICAgICAgICAgICAgICBmaWxlcy5wdXNoKGNoaWxkKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoY2hpbGQgaW5zdGFuY2VvZiBURm9sZGVyKSB7XG4gICAgICAgICAgICAgICAgLy8gUmVjdXJzaXZlbHkgZ2V0IGZpbGVzIGZyb20gc3ViZm9sZGVyc1xuICAgICAgICAgICAgICAgIGZpbGVzLnB1c2goLi4udGhpcy5jb2xsZWN0TWFya2Rvd25GaWxlcyhjaGlsZCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gZmlsZXM7XG4gICAgfVxuXG4gICAgLy8gU2NhbiBhbGwgdGFzayBmb2xkZXJzIGFuZCByZXR1cm4gdGFza3MgKGluY2x1ZGluZyBzdWJmb2xkZXJzKVxuICAgIGFzeW5jIHNjYW5UYXNrcygpOiBQcm9taXNlPFRhc2tbXT4ge1xuICAgICAgICBjb25zdCB0YXNrczogVGFza1tdID0gW107XG4gICAgICAgIGNvbnN0IHZhdWx0ID0gdGhpcy5hcHAudmF1bHQ7XG5cbiAgICAgICAgLy8gR2V0IGFsbCBmb2xkZXJzIGluIHZhdWx0XG4gICAgICAgIGNvbnN0IGFsbEZvbGRlcnMgPSB2YXVsdC5nZXRBbGxMb2FkZWRGaWxlcygpXG4gICAgICAgICAgICAuZmlsdGVyKGYgPT4gZiBpbnN0YW5jZW9mIFRGb2xkZXIpIGFzIFRGb2xkZXJbXTtcblxuICAgICAgICAvLyBGaW5kIHRhc2sgZm9sZGVycyAoZXhhY3QgbWF0Y2hlcyBvciBmb2xkZXJzIGVuZGluZyB3aXRoIC90YXNrcywgZXRjLilcbiAgICAgICAgY29uc3QgdGFza0ZvbGRlcnM6IFRGb2xkZXJbXSA9IFtdO1xuICAgICAgICBmb3IgKGNvbnN0IGZvbGRlciBvZiBhbGxGb2xkZXJzKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5zZXR0aW5ncy50YXNrRm9sZGVycy5zb21lKHRmID0+IFxuICAgICAgICAgICAgICAgIGZvbGRlci5wYXRoID09PSB0ZiB8fCBcbiAgICAgICAgICAgICAgICBmb2xkZXIucGF0aC5lbmRzV2l0aCgnLycgKyB0ZikgfHxcbiAgICAgICAgICAgICAgICBmb2xkZXIubmFtZSA9PT0gdGZcbiAgICAgICAgICAgICkpIHtcbiAgICAgICAgICAgICAgICB0YXNrRm9sZGVycy5wdXNoKGZvbGRlcik7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBTY2FuIGVhY2ggdGFzayBmb2xkZXIgcmVjdXJzaXZlbHlcbiAgICAgICAgZm9yIChjb25zdCBmb2xkZXIgb2YgdGFza0ZvbGRlcnMpIHtcbiAgICAgICAgICAgIC8vIFJlY3Vyc2l2ZWx5IGNvbGxlY3QgYWxsIG1hcmtkb3duIGZpbGVzIGluY2x1ZGluZyBzdWJmb2xkZXJzXG4gICAgICAgICAgICBjb25zdCBmaWxlcyA9IHRoaXMuY29sbGVjdE1hcmtkb3duRmlsZXMoZm9sZGVyKTtcblxuICAgICAgICAgICAgZm9yIChjb25zdCBmaWxlIG9mIGZpbGVzKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgdGFzayA9IGF3YWl0IHRoaXMucGFyc2VUYXNrRmlsZShmaWxlLCBmb2xkZXIpO1xuICAgICAgICAgICAgICAgIGlmICh0YXNrKSB7XG4gICAgICAgICAgICAgICAgICAgIHRhc2tzLnB1c2godGFzayk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRhc2tzO1xuICAgIH1cblxuICAgIC8vIFBhcnNlIGEgdGFzayBmaWxlIGFuZCBleHRyYWN0IG1ldGFkYXRhXG4gICAgYXN5bmMgcGFyc2VUYXNrRmlsZShmaWxlOiBURmlsZSwgZm9sZGVyOiBURm9sZGVyKTogUHJvbWlzZTxUYXNrIHwgbnVsbD4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgY2FjaGUgPSB0aGlzLmFwcC5tZXRhZGF0YUNhY2hlLmdldEZpbGVDYWNoZShmaWxlKTtcbiAgICAgICAgICAgIGNvbnN0IGZyb250bWF0dGVyID0gY2FjaGU/LmZyb250bWF0dGVyO1xuXG4gICAgICAgICAgICAvLyBSZWFkIGZpbGUgY29udGVudCBmb3IgdGl0bGUgKGZpcnN0IGxpbmUgb3IgaDEpXG4gICAgICAgICAgICBjb25zdCBjb250ZW50ID0gYXdhaXQgdGhpcy5hcHAudmF1bHQucmVhZChmaWxlKTtcbiAgICAgICAgICAgIGxldCB0aXRsZSA9IGZpbGUuYmFzZW5hbWU7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIFRyeSB0byBmaW5kIGEgYmV0dGVyIHRpdGxlIGZyb20gY29udGVudFxuICAgICAgICAgICAgY29uc3QgbGluZXMgPSBjb250ZW50LnNwbGl0KCdcXG4nKTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgICAgICAgICAgICAgIGNvbnN0IHRyaW1tZWQgPSBsaW5lLnRyaW0oKTtcbiAgICAgICAgICAgICAgICBpZiAodHJpbW1lZCAmJiAhdHJpbW1lZC5zdGFydHNXaXRoKCctLS0nKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAodHJpbW1lZC5zdGFydHNXaXRoKCcjICcpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aXRsZSA9IHRyaW1tZWQuc3Vic3RyaW5nKDIpLnRyaW0oKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIEdldCBwYXJlbnQgZm9sZGVyIG5hbWUgYXMgY2F0ZWdvcnlcbiAgICAgICAgICAgIGNvbnN0IGZvbGRlclBhcnRzID0gZm9sZGVyLnBhdGguc3BsaXQoJy8nKTtcbiAgICAgICAgICAgIGNvbnN0IHBhcmVudEZvbGRlciA9IGZvbGRlclBhcnRzLmxlbmd0aCA+IDEgPyBmb2xkZXJQYXJ0c1tmb2xkZXJQYXJ0cy5sZW5ndGggLSAyXSA6ICdSb290JztcblxuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBpZDogZmlsZS5wYXRoLFxuICAgICAgICAgICAgICAgIGZpbGU6IGZpbGUsXG4gICAgICAgICAgICAgICAgdGl0bGU6IHRpdGxlLFxuICAgICAgICAgICAgICAgIHN0YXR1czogZnJvbnRtYXR0ZXI/LnN0YXR1cyB8fCB0aGlzLnNldHRpbmdzLmRlZmF1bHRTdGF0dXMsXG4gICAgICAgICAgICAgICAgdGFnOiBmcm9udG1hdHRlcj8udGFnIHx8ICd1bnRhZ2dlZCcsXG4gICAgICAgICAgICAgICAgcHJpb3JpdHk6IChmcm9udG1hdHRlcj8ucHJpb3JpdHkgfHwgJ21lZGl1bScpIGFzICdoaWdoJyB8ICdtZWRpdW0nIHwgJ2xvdycsXG4gICAgICAgICAgICAgICAgY29udGVudDogY29udGVudCxcbiAgICAgICAgICAgICAgICBmb2xkZXI6IHBhcmVudEZvbGRlclxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIHBhcnNpbmcgdGFzayBmaWxlOicsIGZpbGUucGF0aCwgZXJyb3IpO1xuICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBVcGRhdGUgdGFzayBzdGF0dXNcbiAgICBhc3luYyB1cGRhdGVUYXNrU3RhdHVzKHRhc2s6IFRhc2ssIG5ld1N0YXR1czogc3RyaW5nKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBjYWNoZSA9IHRoaXMuYXBwLm1ldGFkYXRhQ2FjaGUuZ2V0RmlsZUNhY2hlKHRhc2suZmlsZSk7XG4gICAgICAgICAgICBjb25zdCBmcm9udG1hdHRlciA9IGNhY2hlPy5mcm9udG1hdHRlcjtcblxuICAgICAgICAgICAgaWYgKGZyb250bWF0dGVyKSB7XG4gICAgICAgICAgICAgICAgLy8gVXBkYXRlIGZyb250bWF0dGVyXG4gICAgICAgICAgICAgICAgY29uc3QgY29udGVudCA9IGF3YWl0IHRoaXMuYXBwLnZhdWx0LnJlYWQodGFzay5maWxlKTtcbiAgICAgICAgICAgICAgICBjb25zdCBmcm9udG1hdHRlclJlZ2V4ID0gL14tLS1cXG4oW1xcc1xcU10qPylcXG4tLS0vO1xuICAgICAgICAgICAgICAgIGNvbnN0IG1hdGNoID0gY29udGVudC5tYXRjaChmcm9udG1hdHRlclJlZ2V4KTtcblxuICAgICAgICAgICAgICAgIGlmIChtYXRjaCkge1xuICAgICAgICAgICAgICAgICAgICBsZXQgbmV3RnJvbnRtYXR0ZXIgPSBtYXRjaFsxXTtcbiAgICAgICAgICAgICAgICAgICAgLy8gUmVwbGFjZSBzdGF0dXMgbGluZVxuICAgICAgICAgICAgICAgICAgICBuZXdGcm9udG1hdHRlciA9IG5ld0Zyb250bWF0dGVyLnJlcGxhY2UoXG4gICAgICAgICAgICAgICAgICAgICAgICAvc3RhdHVzOlxccypcXHcrLyxcbiAgICAgICAgICAgICAgICAgICAgICAgIGBzdGF0dXM6ICR7bmV3U3RhdHVzfWBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgLy8gSWYgc3RhdHVzIGRvZXNuJ3QgZXhpc3QsIGFkZCBpdFxuICAgICAgICAgICAgICAgICAgICBpZiAoIW5ld0Zyb250bWF0dGVyLmluY2x1ZGVzKCdzdGF0dXM6JykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG5ld0Zyb250bWF0dGVyID0gYHN0YXR1czogJHtuZXdTdGF0dXN9XFxuJHtuZXdGcm9udG1hdHRlcn1gO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbmV3Q29udGVudCA9IGNvbnRlbnQucmVwbGFjZShmcm9udG1hdHRlclJlZ2V4LCBgLS0tXFxuJHtuZXdGcm9udG1hdHRlcn1cXG4tLS1gKTtcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hcHAudmF1bHQubW9kaWZ5KHRhc2suZmlsZSwgbmV3Q29udGVudCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyBBZGQgZnJvbnRtYXR0ZXIgaWYgaXQgZG9lc24ndCBleGlzdFxuICAgICAgICAgICAgICAgIGNvbnN0IG5ld0Zyb250bWF0dGVyID0gYC0tLVxcbnN0YXR1czogJHtuZXdTdGF0dXN9XFxudGFnOiAke3Rhc2sudGFnfVxcbnByaW9yaXR5OiAke3Rhc2sucHJpb3JpdHl9XFxuLS0tXFxuXFxuYDtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5tb2RpZnkodGFzay5maWxlLCBuZXdGcm9udG1hdHRlciArIHRhc2suY29udGVudCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRhc2suc3RhdHVzID0gbmV3U3RhdHVzO1xuICAgICAgICAgICAgbmV3IE5vdGljZShgVGFzayBtb3ZlZCB0byAke25ld1N0YXR1c31gKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIHVwZGF0aW5nIHRhc2sgc3RhdHVzOicsIGVycm9yKTtcbiAgICAgICAgICAgIG5ldyBOb3RpY2UoJ0ZhaWxlZCB0byB1cGRhdGUgdGFzayBzdGF0dXMnKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIFVwZGF0ZSB0YXNrIHByaW9yaXR5XG4gICAgYXN5bmMgdXBkYXRlVGFza1ByaW9yaXR5KHRhc2s6IFRhc2ssIG5ld1ByaW9yaXR5OiBzdHJpbmcpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCB0aGlzLmFwcC52YXVsdC5yZWFkKHRhc2suZmlsZSk7XG4gICAgICAgICAgICBjb25zdCBmcm9udG1hdHRlclJlZ2V4ID0gL14tLS1cXG4oW1xcc1xcU10qPylcXG4tLS0vO1xuICAgICAgICAgICAgY29uc3QgbWF0Y2ggPSBjb250ZW50Lm1hdGNoKGZyb250bWF0dGVyUmVnZXgpO1xuXG4gICAgICAgICAgICBpZiAobWF0Y2gpIHtcbiAgICAgICAgICAgICAgICBsZXQgbmV3RnJvbnRtYXR0ZXIgPSBtYXRjaFsxXTtcbiAgICAgICAgICAgICAgICBuZXdGcm9udG1hdHRlciA9IG5ld0Zyb250bWF0dGVyLnJlcGxhY2UoXG4gICAgICAgICAgICAgICAgICAgIC9wcmlvcml0eTpcXHMqXFx3Ky8sXG4gICAgICAgICAgICAgICAgICAgIGBwcmlvcml0eTogJHtuZXdQcmlvcml0eX1gXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICBpZiAoIW5ld0Zyb250bWF0dGVyLmluY2x1ZGVzKCdwcmlvcml0eTonKSkge1xuICAgICAgICAgICAgICAgICAgICBuZXdGcm9udG1hdHRlciA9IG5ld0Zyb250bWF0dGVyLnJlcGxhY2UoXG4gICAgICAgICAgICAgICAgICAgICAgICAvKHN0YXR1czpbXlxcbl0qKS8sXG4gICAgICAgICAgICAgICAgICAgICAgICBgJDFcXG5wcmlvcml0eTogJHtuZXdQcmlvcml0eX1gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29uc3QgbmV3Q29udGVudCA9IGNvbnRlbnQucmVwbGFjZShmcm9udG1hdHRlclJlZ2V4LCBgLS0tXFxuJHtuZXdGcm9udG1hdHRlcn1cXG4tLS1gKTtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5tb2RpZnkodGFzay5maWxlLCBuZXdDb250ZW50KTtcbiAgICAgICAgICAgICAgICB0YXNrLnByaW9yaXR5ID0gbmV3UHJpb3JpdHkgYXMgJ2hpZ2gnIHwgJ21lZGl1bScgfCAnbG93JztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIHVwZGF0aW5nIHRhc2sgcHJpb3JpdHk6JywgZXJyb3IpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gVXBkYXRlIHRhc2sgdGFnXG4gICAgYXN5bmMgdXBkYXRlVGFzayh0YXNrOiBUYXNrLCBuZXdUYWc6IHN0cmluZykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgY29udGVudCA9IGF3YWl0IHRoaXMuYXBwLnZhdWx0LnJlYWQodGFzay5maWxlKTtcbiAgICAgICAgICAgIGNvbnN0IGZyb250bWF0dGVyUmVnZXggPSAvXi0tLVxcbihbXFxzXFxTXSo/KVxcbi0tLS87XG4gICAgICAgICAgICBjb25zdCBtYXRjaCA9IGNvbnRlbnQubWF0Y2goZnJvbnRtYXR0ZXJSZWdleCk7XG5cbiAgICAgICAgICAgIGlmIChtYXRjaCkge1xuICAgICAgICAgICAgICAgIGxldCBuZXdGcm9udG1hdHRlciA9IG1hdGNoWzFdO1xuICAgICAgICAgICAgICAgIG5ld0Zyb250bWF0dGVyID0gbmV3RnJvbnRtYXR0ZXIucmVwbGFjZShcbiAgICAgICAgICAgICAgICAgICAgL3RhZzpcXHMqXFxTKy8sXG4gICAgICAgICAgICAgICAgICAgIGB0YWc6ICR7bmV3VGFnfWBcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIGlmICghbmV3RnJvbnRtYXR0ZXIuaW5jbHVkZXMoJ3RhZzonKSkge1xuICAgICAgICAgICAgICAgICAgICBuZXdGcm9udG1hdHRlciA9IG5ld0Zyb250bWF0dGVyLnJlcGxhY2UoXG4gICAgICAgICAgICAgICAgICAgICAgICAvKHN0YXR1czpbXlxcbl0qKS8sXG4gICAgICAgICAgICAgICAgICAgICAgICBgJDFcXG50YWc6ICR7bmV3VGFnfWBcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdCBuZXdDb250ZW50ID0gY29udGVudC5yZXBsYWNlKGZyb250bWF0dGVyUmVnZXgsIGAtLS1cXG4ke25ld0Zyb250bWF0dGVyfVxcbi0tLWApO1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYXBwLnZhdWx0Lm1vZGlmeSh0YXNrLmZpbGUsIG5ld0NvbnRlbnQpO1xuICAgICAgICAgICAgICAgIHRhc2sudGFnID0gbmV3VGFnO1xuICAgICAgICAgICAgICAgIG5ldyBOb3RpY2UoYFRhc2sgdGFnIGNoYW5nZWQgdG8gJHtuZXdUYWd9YCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKCdFcnJvciB1cGRhdGluZyB0YXNrIHRhZzonLCBlcnJvcik7XG4gICAgICAgICAgICBuZXcgTm90aWNlKCdGYWlsZWQgdG8gdXBkYXRlIHRhc2sgdGFnJyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBNb3ZlIHRhc2sgdG8gZGlmZmVyZW50IGZvbGRlclxuICAgIGFzeW5jIG1vdmVUYXNrVG9Gb2xkZXIodGFzazogVGFzaywgdGFyZ2V0Rm9sZGVyOiBURm9sZGVyKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBuZXdQYXRoID0gYCR7dGFyZ2V0Rm9sZGVyLnBhdGh9LyR7dGFzay5maWxlLm5hbWV9YDtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuYXBwLnZhdWx0LnJlbmFtZSh0YXNrLmZpbGUsIG5ld1BhdGgpO1xuICAgICAgICAgICAgbmV3IE5vdGljZShgVGFzayBtb3ZlZCB0byAke3RhcmdldEZvbGRlci5uYW1lfWApO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgY29uc29sZS5lcnJvcignRXJyb3IgbW92aW5nIHRhc2s6JywgZXJyb3IpO1xuICAgICAgICAgICAgbmV3IE5vdGljZSgnRmFpbGVkIHRvIG1vdmUgdGFzaycpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIGEgbmV3IHRhc2tcbiAgICBhc3luYyBjcmVhdGVOZXdUYXNrKHRpdGxlOiBzdHJpbmcsIGZvbGRlck5hbWU6IHN0cmluZywgdGFnOiBzdHJpbmcsIHByaW9yaXR5OiBzdHJpbmcgPSAnbWVkaXVtJykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgLy8gRmluZCB0aGUgYmFzZSB0YXNrcyBmb2xkZXJcbiAgICAgICAgICAgIGNvbnN0IHZhdWx0ID0gdGhpcy5hcHAudmF1bHQ7XG4gICAgICAgICAgICBjb25zdCBhbGxGb2xkZXJzID0gdmF1bHQuZ2V0QWxsTG9hZGVkRmlsZXMoKVxuICAgICAgICAgICAgICAgIC5maWx0ZXIoZiA9PiBmIGluc3RhbmNlb2YgVEZvbGRlcikgYXMgVEZvbGRlcltdO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgdGFyZ2V0Rm9sZGVyOiBURm9sZGVyIHwgbnVsbCA9IG51bGw7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIEZpbmQgdGhlIHRhc2tzIGZvbGRlciB0aGF0IGNvbnRhaW5zIHRoaXMgZm9sZGVyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGZvbGRlciBvZiBhbGxGb2xkZXJzKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZvbGRlci5uYW1lID09PSBmb2xkZXJOYW1lIHx8IGZvbGRlci5wYXRoLmluY2x1ZGVzKGAvJHtmb2xkZXJOYW1lfS9gKSB8fCBmb2xkZXIucGF0aC5lbmRzV2l0aChgLyR7Zm9sZGVyTmFtZX1gKSkge1xuICAgICAgICAgICAgICAgICAgICAvLyBDaGVjayBpZiB0aGlzIGlzIGEgdGFzayBmb2xkZXJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgaXNUYXNrRm9sZGVyID0gdGhpcy5zZXR0aW5ncy50YXNrRm9sZGVycy5zb21lKHRmID0+IFxuICAgICAgICAgICAgICAgICAgICAgICAgZm9sZGVyLnBhdGggPT09IHRmIHx8IFxuICAgICAgICAgICAgICAgICAgICAgICAgZm9sZGVyLnBhdGguZW5kc1dpdGgoJy8nICsgdGYpIHx8XG4gICAgICAgICAgICAgICAgICAgICAgICBmb2xkZXIubmFtZSA9PT0gdGZcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGlzVGFza0ZvbGRlciB8fCBmb2xkZXIucGF0aC5pbmNsdWRlcygnL3Rhc2tzLycpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0YXJnZXRGb2xkZXIgPSBmb2xkZXI7XG4gICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy8gRmFsbGJhY2s6IGZpbmQgYW55IHRhc2tzIGZvbGRlclxuICAgICAgICAgICAgaWYgKCF0YXJnZXRGb2xkZXIpIHtcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGZvbGRlciBvZiBhbGxGb2xkZXJzKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLnNldHRpbmdzLnRhc2tGb2xkZXJzLnNvbWUodGYgPT4gXG4gICAgICAgICAgICAgICAgICAgICAgICBmb2xkZXIubmFtZSA9PT0gdGYgfHwgZm9sZGVyLnBhdGguZW5kc1dpdGgoJy8nICsgdGYpXG4gICAgICAgICAgICAgICAgICAgICkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhcmdldEZvbGRlciA9IGZvbGRlcjtcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIXRhcmdldEZvbGRlcikge1xuICAgICAgICAgICAgICAgIG5ldyBOb3RpY2UoJ0NvdWxkIG5vdCBmaW5kIHRhc2tzIGZvbGRlcicpO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gQ3JlYXRlIGZvbGRlciBmb3IgdGFnIGlmIGl0IGRvZXNuJ3QgZXhpc3RcbiAgICAgICAgICAgIGNvbnN0IHRhZ0ZvbGRlclBhdGggPSBgJHt0YXJnZXRGb2xkZXIucGF0aH0vJHt0YWd9YDtcbiAgICAgICAgICAgIGxldCB0YWdGb2xkZXIgPSB2YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgodGFnRm9sZGVyUGF0aCk7XG4gICAgICAgICAgICBpZiAoIXRhZ0ZvbGRlcikge1xuICAgICAgICAgICAgICAgIGF3YWl0IHZhdWx0LmNyZWF0ZUZvbGRlcih0YWdGb2xkZXJQYXRoKTtcbiAgICAgICAgICAgICAgICB0YWdGb2xkZXIgPSB2YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgodGFnRm9sZGVyUGF0aCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghKHRhZ0ZvbGRlciBpbnN0YW5jZW9mIFRGb2xkZXIpKSB7XG4gICAgICAgICAgICAgICAgbmV3IE5vdGljZSgnRXJyb3IgY3JlYXRpbmcgdGFnIGZvbGRlcicpO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gR2VuZXJhdGUgZmlsZW5hbWUgZnJvbSB0aXRsZVxuICAgICAgICAgICAgY29uc3QgZmlsZW5hbWUgPSB0aXRsZS50b0xvd2VyQ2FzZSgpXG4gICAgICAgICAgICAgICAgLnJlcGxhY2UoL1teYS16MC05XFxzLV0vZywgJycpXG4gICAgICAgICAgICAgICAgLnJlcGxhY2UoL1xccysvZywgJy0nKVxuICAgICAgICAgICAgICAgIC5zdWJzdHJpbmcoMCwgNTApIHx8ICduZXctdGFzayc7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnN0IGZpbGVQYXRoID0gYCR7dGFnRm9sZGVyUGF0aH0vJHtmaWxlbmFtZX0ubWRgO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICAvLyBDaGVjayBpZiBmaWxlIGV4aXN0cyBhbmQgYXBwZW5kIG51bWJlciBpZiBuZWVkZWRcbiAgICAgICAgICAgIGxldCBmaW5hbFBhdGggPSBmaWxlUGF0aDtcbiAgICAgICAgICAgIGxldCBjb3VudGVyID0gMTtcbiAgICAgICAgICAgIHdoaWxlICh2YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgoZmluYWxQYXRoKSkge1xuICAgICAgICAgICAgICAgIGZpbmFsUGF0aCA9IGAke3RhZ0ZvbGRlclBhdGh9LyR7ZmlsZW5hbWV9LSR7Y291bnRlcn0ubWRgO1xuICAgICAgICAgICAgICAgIGNvdW50ZXIrKztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gQ3JlYXRlIHRhc2sgY29udGVudFxuICAgICAgICAgICAgY29uc3QgY29udGVudCA9IGAtLS1cbnN0YXR1czogdG9kb1xudGFnOiAke3RhZ31cbnByaW9yaXR5OiAke3ByaW9yaXR5fVxuLS0tXG5cbiMgJHt0aXRsZX1cblxuYDtcblxuICAgICAgICAgICAgYXdhaXQgdmF1bHQuY3JlYXRlKGZpbmFsUGF0aCwgY29udGVudCk7XG4gICAgICAgICAgICBuZXcgTm90aWNlKGBUYXNrIGNyZWF0ZWQ6ICR7dGl0bGV9YCk7XG4gICAgICAgICAgICB0aGlzLnJlZnJlc2hWaWV3KCk7XG5cbiAgICAgICAgICAgIC8vIE9wZW4gdGhlIG5ldyBmaWxlXG4gICAgICAgICAgICBjb25zdCBuZXdGaWxlID0gdmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKGZpbmFsUGF0aCk7XG4gICAgICAgICAgICBpZiAobmV3RmlsZSBpbnN0YW5jZW9mIFRGaWxlKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLm9wZW5MaW5rVGV4dChuZXdGaWxlLnBhdGgsICcnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIGNyZWF0aW5nIHRhc2s6JywgZXJyb3IpO1xuICAgICAgICAgICAgbmV3IE5vdGljZSgnRmFpbGVkIHRvIGNyZWF0ZSB0YXNrJyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBPcmdhbml6ZSBhbGwgdGFza3MgYnkgdGFnIC0gbW92ZXMgZmlsZXMgaW50byBzdWJmb2xkZXJzIG5hbWVkIGFmdGVyIHRoZWlyIHRhZ3NcbiAgICBhc3luYyBvcmdhbml6ZVRhc2tzQnlUYWcoKSB7XG4gICAgICAgIGNvbnN0IHRhc2tzID0gYXdhaXQgdGhpcy5zY2FuVGFza3MoKTtcbiAgICAgICAgY29uc3QgdGFza3NCeVRhZyA9IG5ldyBNYXA8c3RyaW5nLCBUYXNrW10+KCk7XG5cbiAgICAgICAgLy8gR3JvdXAgdGFza3MgYnkgdGFnXG4gICAgICAgIGZvciAoY29uc3QgdGFzayBvZiB0YXNrcykge1xuICAgICAgICAgICAgY29uc3QgdGFnID0gdGFzay50YWcgfHwgJ3VudGFnZ2VkJztcbiAgICAgICAgICAgIGlmICghdGFza3NCeVRhZy5oYXModGFnKSkge1xuICAgICAgICAgICAgICAgIHRhc2tzQnlUYWcuc2V0KHRhZywgW10pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGFza3NCeVRhZy5nZXQodGFnKSEucHVzaCh0YXNrKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBtb3ZlZENvdW50ID0gMDtcbiAgICAgICAgY29uc3QgdmF1bHQgPSB0aGlzLmFwcC52YXVsdDtcblxuICAgICAgICAvLyBQcm9jZXNzIGVhY2ggdGFnIGdyb3VwXG4gICAgICAgIGZvciAoY29uc3QgW3RhZywgdGFnVGFza3NdIG9mIHRhc2tzQnlUYWcpIHtcbiAgICAgICAgICAgIGZvciAoY29uc3QgdGFzayBvZiB0YWdUYXNrcykge1xuICAgICAgICAgICAgICAgIC8vIFNraXAgaWYgYWxyZWFkeSBpbiBjb3JyZWN0IGZvbGRlclxuICAgICAgICAgICAgICAgIGNvbnN0IGN1cnJlbnRGb2xkZXIgPSB0YXNrLmZpbGUucGFyZW50Py5uYW1lO1xuICAgICAgICAgICAgICAgIGlmIChjdXJyZW50Rm9sZGVyID09PSB0YWcpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgICAgICAgLy8gRGV0ZXJtaW5lIGRlc3RpbmF0aW9uIGZvbGRlclxuICAgICAgICAgICAgICAgIGNvbnN0IGJhc2VGb2xkZXIgPSB0aGlzLmZpbmRCYXNlVGFza0ZvbGRlcih0YXNrLmZpbGUpO1xuICAgICAgICAgICAgICAgIGlmICghYmFzZUZvbGRlcikgY29udGludWU7XG5cbiAgICAgICAgICAgICAgICBjb25zdCB0YXJnZXRGb2xkZXJQYXRoID0gYCR7YmFzZUZvbGRlci5wYXRofS8ke3RhZ31gO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIENyZWF0ZSB0YXJnZXQgZm9sZGVyIGlmIGl0IGRvZXNuJ3QgZXhpc3RcbiAgICAgICAgICAgICAgICAgICAgbGV0IHRhcmdldEZvbGRlciA9IHZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aCh0YXJnZXRGb2xkZXJQYXRoKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCF0YXJnZXRGb2xkZXIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IHZhdWx0LmNyZWF0ZUZvbGRlcih0YXJnZXRGb2xkZXJQYXRoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhcmdldEZvbGRlciA9IHZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aCh0YXJnZXRGb2xkZXJQYXRoKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICh0YXJnZXRGb2xkZXIgaW5zdGFuY2VvZiBURm9sZGVyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBuZXdQYXRoID0gYCR7dGFyZ2V0Rm9sZGVyUGF0aH0vJHt0YXNrLmZpbGUubmFtZX1gO1xuICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgdmF1bHQucmVuYW1lKHRhc2suZmlsZSwgbmV3UGF0aCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBtb3ZlZENvdW50Kys7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmVycm9yKGBFcnJvciBtb3ZpbmcgdGFzayAke3Rhc2suZmlsZS5wYXRofTpgLCBlcnJvcik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbmV3IE5vdGljZShgT3JnYW5pemVkICR7bW92ZWRDb3VudH0gdGFza3MgYnkgdGFnYCk7XG4gICAgICAgIHRoaXMucmVmcmVzaFZpZXcoKTtcbiAgICB9XG5cbiAgICAvLyBPcmdhbml6ZSB0YXNrcyBpbiBhIHNwZWNpZmljIGZvbGRlciBieSB0YWdcbiAgICBhc3luYyBvcmdhbml6ZVRhc2tzSW5Gb2xkZXIoZm9sZGVyOiBURm9sZGVyKSB7XG4gICAgICAgIGNvbnN0IGZpbGVzID0gdGhpcy5jb2xsZWN0TWFya2Rvd25GaWxlcyhmb2xkZXIpO1xuICAgICAgICBsZXQgbW92ZWRDb3VudCA9IDA7XG4gICAgICAgIGNvbnN0IHZhdWx0ID0gdGhpcy5hcHAudmF1bHQ7XG5cbiAgICAgICAgZm9yIChjb25zdCBmaWxlIG9mIGZpbGVzKSB7XG4gICAgICAgICAgICBjb25zdCBjYWNoZSA9IHRoaXMuYXBwLm1ldGFkYXRhQ2FjaGUuZ2V0RmlsZUNhY2hlKGZpbGUpO1xuICAgICAgICAgICAgY29uc3QgdGFnID0gY2FjaGU/LmZyb250bWF0dGVyPy50YWcgfHwgJ3VudGFnZ2VkJztcblxuICAgICAgICAgICAgLy8gU2tpcCBpZiBhbHJlYWR5IGluIGNvcnJlY3QgZm9sZGVyXG4gICAgICAgICAgICBjb25zdCBjdXJyZW50Rm9sZGVyID0gZmlsZS5wYXJlbnQ/Lm5hbWU7XG4gICAgICAgICAgICBpZiAoY3VycmVudEZvbGRlciA9PT0gdGFnKSBjb250aW51ZTtcblxuICAgICAgICAgICAgY29uc3QgdGFyZ2V0Rm9sZGVyUGF0aCA9IGAke2ZvbGRlci5wYXRofS8ke3RhZ31gO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIC8vIENyZWF0ZSB0YXJnZXQgZm9sZGVyIGlmIGl0IGRvZXNuJ3QgZXhpc3RcbiAgICAgICAgICAgICAgICBsZXQgdGFyZ2V0Rm9sZGVyID0gdmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHRhcmdldEZvbGRlclBhdGgpO1xuICAgICAgICAgICAgICAgIGlmICghdGFyZ2V0Rm9sZGVyKSB7XG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHZhdWx0LmNyZWF0ZUZvbGRlcih0YXJnZXRGb2xkZXJQYXRoKTtcbiAgICAgICAgICAgICAgICAgICAgdGFyZ2V0Rm9sZGVyID0gdmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHRhcmdldEZvbGRlclBhdGgpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICh0YXJnZXRGb2xkZXIgaW5zdGFuY2VvZiBURm9sZGVyKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG5ld1BhdGggPSBgJHt0YXJnZXRGb2xkZXJQYXRofS8ke2ZpbGUubmFtZX1gO1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCB2YXVsdC5yZW5hbWUoZmlsZSwgbmV3UGF0aCk7XG4gICAgICAgICAgICAgICAgICAgIG1vdmVkQ291bnQrKztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYEVycm9yIG1vdmluZyB0YXNrICR7ZmlsZS5wYXRofTpgLCBlcnJvcik7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBuZXcgTm90aWNlKGBPcmdhbml6ZWQgJHttb3ZlZENvdW50fSB0YXNrcyBpbiAke2ZvbGRlci5uYW1lfSBieSB0YWdgKTtcbiAgICAgICAgdGhpcy5yZWZyZXNoVmlldygpO1xuICAgIH1cblxuICAgIC8vIEZpbmQgdGhlIGJhc2UgdGFzayBmb2xkZXIgZm9yIGEgZmlsZVxuICAgIHByaXZhdGUgZmluZEJhc2VUYXNrRm9sZGVyKGZpbGU6IFRGaWxlKTogVEZvbGRlciB8IG51bGwge1xuICAgICAgICBsZXQgY3VycmVudCA9IGZpbGUucGFyZW50O1xuICAgICAgICBcbiAgICAgICAgd2hpbGUgKGN1cnJlbnQpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLnNldHRpbmdzLnRhc2tGb2xkZXJzLnNvbWUodGYgPT4gXG4gICAgICAgICAgICAgICAgY3VycmVudCEucGF0aCA9PT0gdGYgfHwgXG4gICAgICAgICAgICAgICAgY3VycmVudCEucGF0aC5lbmRzV2l0aCgnLycgKyB0ZikgfHxcbiAgICAgICAgICAgICAgICBjdXJyZW50IS5uYW1lID09PSB0ZlxuICAgICAgICAgICAgKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBjdXJyZW50O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY3VycmVudCA9IGN1cnJlbnQucGFyZW50O1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG59XG5cbi8vIFRhc2sgQm9hcmQgVmlld1xuY2xhc3MgVGFza0JvYXJkVmlldyBleHRlbmRzIEl0ZW1WaWV3IHtcbiAgICBwbHVnaW46IFRhc2tCb2FyZFBsdWdpbjtcbiAgICB0YXNrczogVGFza1tdID0gW107XG4gICAgZmlsdGVyZWRUYXNrczogVGFza1tdID0gW107XG4gICAgY29udGFpbmVyRWw6IEhUTUxFbGVtZW50O1xuICAgIHNvcnRTZWxlY3Q6IERyb3Bkb3duQ29tcG9uZW50O1xuICAgIHNlbGVjdGVkVGFnczogU2V0PHN0cmluZz4gPSBuZXcgU2V0KCk7XG4gICAgdGFnRmlsdGVyQ29udGFpbmVyOiBIVE1MRWxlbWVudCB8IG51bGwgPSBudWxsO1xuICAgIGhpZGRlblN0YXR1c2VzOiBTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoKTtcbiAgICBzZWFyY2hRdWVyeTogc3RyaW5nID0gJyc7XG4gICAgc2VhcmNoSW5wdXQ6IEhUTUxJbnB1dEVsZW1lbnQgfCBudWxsID0gbnVsbDtcblxuICAgIGNvbnN0cnVjdG9yKGxlYWY6IFdvcmtzcGFjZUxlYWYsIHBsdWdpbjogVGFza0JvYXJkUGx1Z2luKSB7XG4gICAgICAgIHN1cGVyKGxlYWYpO1xuICAgICAgICB0aGlzLnBsdWdpbiA9IHBsdWdpbjtcbiAgICAgICAgLy8gSW5pdGlhbGl6ZSBoaWRkZW4gc3RhdHVzZXMgZnJvbSBzZXR0aW5nc1xuICAgICAgICB0aGlzLmhpZGRlblN0YXR1c2VzID0gbmV3IFNldCh0aGlzLnBsdWdpbi5zZXR0aW5ncy5oaWRkZW5TdGF0dXNlcyB8fCBbXSk7XG4gICAgfVxuXG4gICAgZ2V0Vmlld1R5cGUoKTogc3RyaW5nIHtcbiAgICAgICAgcmV0dXJuIFZJRVdfVFlQRV9UQVNLX0JPQVJEO1xuICAgIH1cblxuICAgIGdldERpc3BsYXlUZXh0KCk6IHN0cmluZyB7XG4gICAgICAgIHJldHVybiAnVGFzayBCb2FyZCc7XG4gICAgfVxuXG4gICAgZ2V0SWNvbigpOiBzdHJpbmcge1xuICAgICAgICByZXR1cm4gJ2xheW91dC1ib2FyZCc7XG4gICAgfVxuXG4gICAgYXN5bmMgb25PcGVuKCkge1xuICAgICAgICB0aGlzLmNvbnRhaW5lckVsID0gdGhpcy5jb250ZW50RWwuY3JlYXRlRGl2KHsgY2xzOiAndGFzay1ib2FyZC1jb250YWluZXInIH0pO1xuICAgICAgICBhd2FpdCB0aGlzLnJlZnJlc2goKTtcbiAgICB9XG5cbiAgICBhc3luYyByZWZyZXNoKCkge1xuICAgICAgICB0aGlzLnRhc2tzID0gYXdhaXQgdGhpcy5wbHVnaW4uc2NhblRhc2tzKCk7XG4gICAgICAgIHRoaXMuYXBwbHlGaWx0ZXJzKCk7XG4gICAgICAgIHRoaXMucmVuZGVyKCk7XG4gICAgfVxuXG4gICAgLy8gQXBwbHkgc2VhcmNoIGFuZCB0YWcgZmlsdGVycyB0byB0YXNrc1xuICAgIGFwcGx5RmlsdGVycygpIHtcbiAgICAgICAgbGV0IHJlc3VsdCA9IHRoaXMudGFza3M7XG5cbiAgICAgICAgLy8gQXBwbHkgc2VhcmNoIHF1ZXJ5IGZpbHRlclxuICAgICAgICBpZiAodGhpcy5zZWFyY2hRdWVyeS50cmltKCkpIHtcbiAgICAgICAgICAgIGNvbnN0IHF1ZXJ5ID0gdGhpcy5zZWFyY2hRdWVyeS50b0xvd2VyQ2FzZSgpO1xuICAgICAgICAgICAgcmVzdWx0ID0gcmVzdWx0LmZpbHRlcih0YXNrID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCB0aXRsZU1hdGNoID0gdGFzay50aXRsZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHF1ZXJ5KTtcbiAgICAgICAgICAgICAgICBjb25zdCB0YWdNYXRjaCA9IHRhc2sudGFnLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMocXVlcnkpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGNvbnRlbnRNYXRjaCA9IHRhc2suY29udGVudC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHF1ZXJ5KTtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGl0bGVNYXRjaCB8fCB0YWdNYXRjaCB8fCBjb250ZW50TWF0Y2g7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEFwcGx5IHRhZyBmaWx0ZXIgKG9ubHkgaWYgbm90IGFsbCB0YWdzIHNlbGVjdGVkKVxuICAgICAgICBjb25zdCBhbGxUYWdzID0gdGhpcy5nZXRBbGxUYWdzKCk7XG4gICAgICAgIGlmICh0aGlzLnNlbGVjdGVkVGFncy5zaXplID4gMCAmJiB0aGlzLnNlbGVjdGVkVGFncy5zaXplIDwgYWxsVGFncy5sZW5ndGgpIHtcbiAgICAgICAgICAgIHJlc3VsdCA9IHJlc3VsdC5maWx0ZXIodGFzayA9PiB0aGlzLnNlbGVjdGVkVGFncy5oYXModGFzay50YWcpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuZmlsdGVyZWRUYXNrcyA9IHJlc3VsdDtcbiAgICB9XG5cbiAgICByZW5kZXIoKSB7XG4gICAgICAgIHRoaXMuY29udGFpbmVyRWwuZW1wdHkoKTtcblxuICAgICAgICAvLyBIZWFkZXIgd2l0aCBjb250cm9sc1xuICAgICAgICB0aGlzLnJlbmRlckhlYWRlcigpO1xuXG4gICAgICAgIC8vIFRhZyBmaWx0ZXJcbiAgICAgICAgdGhpcy5yZW5kZXJUYWdGaWx0ZXIoKTtcblxuICAgICAgICAvLyBCb2FyZFxuICAgICAgICB0aGlzLnJlbmRlckJvYXJkKCk7XG4gICAgfVxuXG4gICAgcmVuZGVySGVhZGVyKCkge1xuICAgICAgICBjb25zdCBoZWFkZXIgPSB0aGlzLmNvbnRhaW5lckVsLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stYm9hcmQtaGVhZGVyJyB9KTtcblxuICAgICAgICAvLyBUaXRsZVxuICAgICAgICBoZWFkZXIuY3JlYXRlRWwoJ2gyJywgeyB0ZXh0OiAnVGFzayBCb2FyZCcsIGNsczogJ3Rhc2stYm9hcmQtdGl0bGUnIH0pO1xuXG4gICAgICAgIC8vIFNlYXJjaCBiYXJcbiAgICAgICAgY29uc3Qgc2VhcmNoQ29udGFpbmVyID0gaGVhZGVyLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stc2VhcmNoLWNvbnRhaW5lcicgfSk7XG4gICAgICAgIGNvbnN0IHNlYXJjaElucHV0ID0gc2VhcmNoQ29udGFpbmVyLmNyZWF0ZUVsKCdpbnB1dCcsIHtcbiAgICAgICAgICAgIHR5cGU6ICd0ZXh0JyxcbiAgICAgICAgICAgIHBsYWNlaG9sZGVyOiAnU2VhcmNoIHRhc2tzLi4uJyxcbiAgICAgICAgICAgIGNsczogJ3Rhc2stc2VhcmNoLWlucHV0J1xuICAgICAgICB9KTtcbiAgICAgICAgc2VhcmNoSW5wdXQudmFsdWUgPSB0aGlzLnNlYXJjaFF1ZXJ5O1xuICAgICAgICBcbiAgICAgICAgLy8gU2VhcmNoIGljb25cbiAgICAgICAgY29uc3Qgc2VhcmNoSWNvbiA9IHNlYXJjaENvbnRhaW5lci5jcmVhdGVTcGFuKHsgY2xzOiAndGFzay1zZWFyY2gtaWNvbicsIHRleHQ6ICfwn5SNJyB9KTtcbiAgICAgICAgXG4gICAgICAgIC8vIFJlYWwtdGltZSBzZWFyY2ggd2l0aCBtaW5pbWFsIGRlYm91bmNlXG4gICAgICAgIGxldCBkZWJvdW5jZVRpbWVyOiBudW1iZXI7XG4gICAgICAgIHNlYXJjaElucHV0LmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgKGUpID0+IHtcbiAgICAgICAgICAgIGNsZWFyVGltZW91dChkZWJvdW5jZVRpbWVyKTtcbiAgICAgICAgICAgIHRoaXMuc2VhcmNoUXVlcnkgPSBzZWFyY2hJbnB1dC52YWx1ZTtcbiAgICAgICAgICAgIHRoaXMuYXBwbHlGaWx0ZXJzKCk7XG4gICAgICAgICAgICB0aGlzLnJlbmRlckJvYXJkKCk7XG4gICAgICAgIH0pO1xuICAgICAgICBcbiAgICAgICAgLy8gQ2xlYXIgYnV0dG9uICh2aXNpYmxlIHdoZW4gc2VhcmNoIGhhcyB0ZXh0KVxuICAgICAgICBpZiAodGhpcy5zZWFyY2hRdWVyeSkge1xuICAgICAgICAgICAgY29uc3QgY2xlYXJTZWFyY2hCdG4gPSBzZWFyY2hDb250YWluZXIuY3JlYXRlRWwoJ2J1dHRvbicsIHtcbiAgICAgICAgICAgICAgICBjbHM6ICd0YXNrLXNlYXJjaC1jbGVhcicsXG4gICAgICAgICAgICAgICAgdGV4dDogJ+KclSdcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgY2xlYXJTZWFyY2hCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICAgICAgdGhpcy5zZWFyY2hRdWVyeSA9ICcnO1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwbHlGaWx0ZXJzKCk7XG4gICAgICAgICAgICAgICAgdGhpcy5yZW5kZXIoKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQ29udHJvbHNcbiAgICAgICAgY29uc3QgY29udHJvbHMgPSBoZWFkZXIuY3JlYXRlRGl2KHsgY2xzOiAndGFzay1ib2FyZC1jb250cm9scycgfSk7XG5cbiAgICAgICAgLy8gU29ydCBkcm9wZG93blxuICAgICAgICBjb250cm9scy5jcmVhdGVTcGFuKHsgdGV4dDogJ1NvcnQgYnk6ICcsIGNsczogJ3Rhc2stYm9hcmQtbGFiZWwnIH0pO1xuICAgICAgICBjb25zdCBzb3J0U2VsZWN0ID0gbmV3IERyb3Bkb3duQ29tcG9uZW50KGNvbnRyb2xzKTtcbiAgICAgICAgc29ydFNlbGVjdC5hZGRPcHRpb24oJ3ByaW9yaXR5JywgJ1ByaW9yaXR5Jyk7XG4gICAgICAgIHNvcnRTZWxlY3QuYWRkT3B0aW9uKCd0YWcnLCAnVGFnJyk7XG4gICAgICAgIHNvcnRTZWxlY3QuYWRkT3B0aW9uKCd0aXRsZScsICdUaXRsZScpO1xuICAgICAgICBzb3J0U2VsZWN0LmFkZE9wdGlvbignZm9sZGVyJywgJ0ZvbGRlcicpO1xuICAgICAgICBzb3J0U2VsZWN0LnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLnNvcnRCeSk7XG4gICAgICAgIHNvcnRTZWxlY3Qub25DaGFuZ2UoKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zb3J0QnkgPSB2YWx1ZSBhcyBhbnk7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyQm9hcmQoKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gU29ydCBkaXJlY3Rpb25cbiAgICAgICAgY29uc3QgZGlyQnRuID0gY29udHJvbHMuY3JlYXRlRWwoJ2J1dHRvbicsIHtcbiAgICAgICAgICAgIGNsczogJ3Rhc2stYm9hcmQtc29ydC1kaXInLFxuICAgICAgICAgICAgdGV4dDogdGhpcy5wbHVnaW4uc2V0dGluZ3Muc29ydERpcmVjdGlvbiA9PT0gJ2FzYycgPyAn4oaRJyA6ICfihpMnXG4gICAgICAgIH0pO1xuICAgICAgICBkaXJCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zb3J0RGlyZWN0aW9uID0gXG4gICAgICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3Muc29ydERpcmVjdGlvbiA9PT0gJ2FzYycgPyAnZGVzYycgOiAnYXNjJztcbiAgICAgICAgICAgIGRpckJ0bi50ZXh0Q29udGVudCA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnNvcnREaXJlY3Rpb24gPT09ICdhc2MnID8gJ+KGkScgOiAn4oaTJztcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgdGhpcy5yZW5kZXJCb2FyZCgpO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBDb2x1bW4gdmlzaWJpbGl0eSB0b2dnbGVzXG4gICAgICAgIGNvbnN0IHZpc2liaWxpdHlDb250cm9scyA9IGNvbnRyb2xzLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stYm9hcmQtdmlzaWJpbGl0eScgfSk7XG4gICAgICAgIHZpc2liaWxpdHlDb250cm9scy5jcmVhdGVTcGFuKHsgdGV4dDogJ1Nob3c6ICcsIGNsczogJ3Rhc2stYm9hcmQtbGFiZWwnIH0pO1xuXG4gICAgICAgIC8vIFRvZ2dsZSBmb3IgRG9uZSBjb2x1bW5cbiAgICAgICAgY29uc3QgZG9uZUxhYmVsID0gdmlzaWJpbGl0eUNvbnRyb2xzLmNyZWF0ZUVsKCdsYWJlbCcsIHsgY2xzOiAndmlzaWJpbGl0eS10b2dnbGUnIH0pO1xuICAgICAgICBjb25zdCBkb25lQ2hlY2tib3ggPSBkb25lTGFiZWwuY3JlYXRlRWwoJ2lucHV0Jywge1xuICAgICAgICAgICAgdHlwZTogJ2NoZWNrYm94JyxcbiAgICAgICAgICAgIGNsczogJ3Zpc2liaWxpdHktY2hlY2tib3gnXG4gICAgICAgIH0pO1xuICAgICAgICBkb25lQ2hlY2tib3guY2hlY2tlZCA9ICF0aGlzLmhpZGRlblN0YXR1c2VzLmhhcygnZG9uZScpO1xuICAgICAgICBkb25lTGFiZWwuY3JlYXRlU3Bhbih7IHRleHQ6ICdEb25lJywgY2xzOiAndmlzaWJpbGl0eS10ZXh0JyB9KTtcbiAgICAgICAgZG9uZUNoZWNrYm94LmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHtcbiAgICAgICAgICAgIGlmIChkb25lQ2hlY2tib3guY2hlY2tlZCkge1xuICAgICAgICAgICAgICAgIHRoaXMuaGlkZGVuU3RhdHVzZXMuZGVsZXRlKCdkb25lJyk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMuaGlkZGVuU3RhdHVzZXMuYWRkKCdkb25lJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5oaWRkZW5TdGF0dXNlcyA9IEFycmF5LmZyb20odGhpcy5oaWRkZW5TdGF0dXNlcyk7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyQm9hcmQoKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gVG9nZ2xlIGZvciBBcmNoaXZlIGNvbHVtblxuICAgICAgICBjb25zdCBhcmNoaXZlTGFiZWwgPSB2aXNpYmlsaXR5Q29udHJvbHMuY3JlYXRlRWwoJ2xhYmVsJywgeyBjbHM6ICd2aXNpYmlsaXR5LXRvZ2dsZScgfSk7XG4gICAgICAgIGNvbnN0IGFyY2hpdmVDaGVja2JveCA9IGFyY2hpdmVMYWJlbC5jcmVhdGVFbCgnaW5wdXQnLCB7XG4gICAgICAgICAgICB0eXBlOiAnY2hlY2tib3gnLFxuICAgICAgICAgICAgY2xzOiAndmlzaWJpbGl0eS1jaGVja2JveCdcbiAgICAgICAgfSk7XG4gICAgICAgIGFyY2hpdmVDaGVja2JveC5jaGVja2VkID0gIXRoaXMuaGlkZGVuU3RhdHVzZXMuaGFzKCdhcmNoaXZlJyk7XG4gICAgICAgIGFyY2hpdmVMYWJlbC5jcmVhdGVTcGFuKHsgdGV4dDogJ0FyY2hpdmUnLCBjbHM6ICd2aXNpYmlsaXR5LXRleHQnIH0pO1xuICAgICAgICBhcmNoaXZlQ2hlY2tib3guYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4ge1xuICAgICAgICAgICAgaWYgKGFyY2hpdmVDaGVja2JveC5jaGVja2VkKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5oaWRkZW5TdGF0dXNlcy5kZWxldGUoJ2FyY2hpdmUnKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhpcy5oaWRkZW5TdGF0dXNlcy5hZGQoJ2FyY2hpdmUnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLmhpZGRlblN0YXR1c2VzID0gQXJyYXkuZnJvbSh0aGlzLmhpZGRlblN0YXR1c2VzKTtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgdGhpcy5yZW5kZXJCb2FyZCgpO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBPcmdhbml6ZSBieSB0YWcgYnV0dG9uXG4gICAgICAgIGNvbnN0IG9yZ2FuaXplQnRuID0gY29udHJvbHMuY3JlYXRlRWwoJ2J1dHRvbicsIHtcbiAgICAgICAgICAgIGNsczogJ3Rhc2stYm9hcmQtb3JnYW5pemUnLFxuICAgICAgICAgICAgdGV4dDogJ/Cfk4EgT3JnYW5pemUnXG4gICAgICAgIH0pO1xuICAgICAgICBvcmdhbml6ZUJ0bi50aXRsZSA9ICdPcmdhbml6ZSB0YXNrcyBieSB0YWcnO1xuICAgICAgICBvcmdhbml6ZUJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLm9yZ2FuaXplVGFza3NCeVRhZygpO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBSZWZyZXNoIGJ1dHRvblxuICAgICAgICBjb25zdCByZWZyZXNoQnRuID0gY29udHJvbHMuY3JlYXRlRWwoJ2J1dHRvbicsIHtcbiAgICAgICAgICAgIGNsczogJ3Rhc2stYm9hcmQtcmVmcmVzaCcsXG4gICAgICAgICAgICB0ZXh0OiAn8J+UhCdcbiAgICAgICAgfSk7XG4gICAgICAgIHJlZnJlc2hCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB0aGlzLnJlZnJlc2goKSk7XG5cbiAgICAgICAgLy8gQ2xlYXIgZmlsdGVycyBidXR0b24gKGhpZGRlbiBieSBkZWZhdWx0KVxuICAgICAgICBjb25zdCBjbGVhckJ0biA9IGNvbnRyb2xzLmNyZWF0ZUVsKCdidXR0b24nLCB7XG4gICAgICAgICAgICBjbHM6ICd0YXNrLWJvYXJkLWNsZWFyLWZpbHRlcnMnLFxuICAgICAgICAgICAgdGV4dDogJ+KclSBDbGVhcidcbiAgICAgICAgfSk7XG4gICAgICAgIGNsZWFyQnRuLnN0eWxlLmRpc3BsYXkgPSB0aGlzLnNlbGVjdGVkVGFncy5zaXplID4gMCA/ICdpbmxpbmUtYmxvY2snIDogJ25vbmUnO1xuICAgICAgICBjbGVhckJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgICAgIHRoaXMuc2VsZWN0ZWRUYWdzLmNsZWFyKCk7XG4gICAgICAgICAgICB0aGlzLnJlbmRlclRhZ0ZpbHRlcigpO1xuICAgICAgICAgICAgdGhpcy5yZW5kZXJCb2FyZCgpO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBHZXQgYWxsIHVuaXF1ZSB0YWdzIGZyb20gdGFza3NcbiAgICBnZXRBbGxUYWdzKCk6IHN0cmluZ1tdIHtcbiAgICAgICAgY29uc3QgdGFncyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgICAgICBmb3IgKGNvbnN0IHRhc2sgb2YgdGhpcy50YXNrcykge1xuICAgICAgICAgICAgaWYgKHRhc2sudGFnKSB7XG4gICAgICAgICAgICAgICAgdGFncy5hZGQodGFzay50YWcpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiBBcnJheS5mcm9tKHRhZ3MpLnNvcnQoKTtcbiAgICB9XG5cbiAgICAvLyBSZW5kZXIgdGFnIGZpbHRlciBjaGVja2JveGVzXG4gICAgcmVuZGVyVGFnRmlsdGVyKCkge1xuICAgICAgICAvLyBSZW1vdmUgZXhpc3RpbmcgZmlsdGVyIGlmIGFueVxuICAgICAgICBpZiAodGhpcy50YWdGaWx0ZXJDb250YWluZXIpIHtcbiAgICAgICAgICAgIHRoaXMudGFnRmlsdGVyQ29udGFpbmVyLnJlbW92ZSgpO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgdGFncyA9IHRoaXMuZ2V0QWxsVGFncygpO1xuICAgICAgICBpZiAodGFncy5sZW5ndGggPT09IDApIHJldHVybjtcblxuICAgICAgICAvLyBBdXRvLXNlbGVjdCBhbGwgdGFncyBpZiBub25lIHNlbGVjdGVkIChkZWZhdWx0IGJlaGF2aW9yKVxuICAgICAgICBpZiAodGhpcy5zZWxlY3RlZFRhZ3Muc2l6ZSA9PT0gMCkge1xuICAgICAgICAgICAgdGFncy5mb3JFYWNoKHRhZyA9PiB0aGlzLnNlbGVjdGVkVGFncy5hZGQodGFnKSk7XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLnRhZ0ZpbHRlckNvbnRhaW5lciA9IHRoaXMuY29udGFpbmVyRWwuY3JlYXRlRGl2KHsgY2xzOiAndGFzay10YWctZmlsdGVyJyB9KTtcbiAgICAgICAgXG4gICAgICAgIGNvbnN0IGZpbHRlckhlYWRlciA9IHRoaXMudGFnRmlsdGVyQ29udGFpbmVyLmNyZWF0ZURpdih7IGNsczogJ3RhZy1maWx0ZXItaGVhZGVyJyB9KTtcbiAgICAgICAgZmlsdGVySGVhZGVyLmNyZWF0ZVNwYW4oeyB0ZXh0OiAnRmlsdGVyIGJ5IHRhZzonLCBjbHM6ICd0YWctZmlsdGVyLWxhYmVsJyB9KTtcblxuICAgICAgICAvLyBTZWxlY3QgYWxsIC8gRGVzZWxlY3QgYWxsIGJ1dHRvbnNcbiAgICAgICAgY29uc3QgYnRuR3JvdXAgPSBmaWx0ZXJIZWFkZXIuY3JlYXRlRGl2KHsgY2xzOiAndGFnLWZpbHRlci1idXR0b25zJyB9KTtcbiAgICAgICAgXG4gICAgICAgIGNvbnN0IHNlbGVjdEFsbEJ0biA9IGJ0bkdyb3VwLmNyZWF0ZUVsKCdidXR0b24nLCB7XG4gICAgICAgICAgICB0ZXh0OiAnQWxsJyxcbiAgICAgICAgICAgIGNsczogJ3RhZy1maWx0ZXItYnRuJ1xuICAgICAgICB9KTtcbiAgICAgICAgc2VsZWN0QWxsQnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICAgICAgdGFncy5mb3JFYWNoKHRhZyA9PiB0aGlzLnNlbGVjdGVkVGFncy5hZGQodGFnKSk7XG4gICAgICAgICAgICB0aGlzLnJlbmRlclRhZ0ZpbHRlcigpO1xuICAgICAgICAgICAgdGhpcy5yZW5kZXJCb2FyZCgpO1xuICAgICAgICB9KTtcblxuICAgICAgICBjb25zdCBkZXNlbGVjdEFsbEJ0biA9IGJ0bkdyb3VwLmNyZWF0ZUVsKCdidXR0b24nLCB7XG4gICAgICAgICAgICB0ZXh0OiAnTm9uZScsXG4gICAgICAgICAgICBjbHM6ICd0YWctZmlsdGVyLWJ0bidcbiAgICAgICAgfSk7XG4gICAgICAgIGRlc2VsZWN0QWxsQnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICAgICAgdGhpcy5zZWxlY3RlZFRhZ3MuY2xlYXIoKTtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyVGFnRmlsdGVyKCk7XG4gICAgICAgICAgICB0aGlzLnJlbmRlckJvYXJkKCk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIENoZWNrYm94IGNvbnRhaW5lclxuICAgICAgICBjb25zdCBjaGVja2JveENvbnRhaW5lciA9IHRoaXMudGFnRmlsdGVyQ29udGFpbmVyLmNyZWF0ZURpdih7IGNsczogJ3RhZy1jaGVja2JveC1jb250YWluZXInIH0pO1xuXG4gICAgICAgIGZvciAoY29uc3QgdGFnIG9mIHRhZ3MpIHtcbiAgICAgICAgICAgIGNvbnN0IGxhYmVsID0gY2hlY2tib3hDb250YWluZXIuY3JlYXRlRWwoJ2xhYmVsJywgeyBjbHM6ICd0YWctY2hlY2tib3gtbGFiZWwnIH0pO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25zdCBjaGVja2JveCA9IGxhYmVsLmNyZWF0ZUVsKCdpbnB1dCcsIHtcbiAgICAgICAgICAgICAgICB0eXBlOiAnY2hlY2tib3gnLFxuICAgICAgICAgICAgICAgIGNsczogJ3RhZy1jaGVja2JveCdcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgY2hlY2tib3guY2hlY2tlZCA9IHRoaXMuc2VsZWN0ZWRUYWdzLmhhcyh0YWcpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBsYWJlbC5jcmVhdGVTcGFuKHsgdGV4dDogdGFnLCBjbHM6ICd0YWctY2hlY2tib3gtdGV4dCcgfSk7XG5cbiAgICAgICAgICAgIC8vIENvdW50IHRhc2tzIHdpdGggdGhpcyB0YWdcbiAgICAgICAgICAgIGNvbnN0IGNvdW50ID0gdGhpcy50YXNrcy5maWx0ZXIodCA9PiB0LnRhZyA9PT0gdGFnKS5sZW5ndGg7XG4gICAgICAgICAgICBsYWJlbC5jcmVhdGVTcGFuKHsgdGV4dDogYCgke2NvdW50fSlgLCBjbHM6ICd0YWctY2hlY2tib3gtY291bnQnIH0pO1xuXG4gICAgICAgICAgICBjaGVja2JveC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGNoZWNrYm94LmNoZWNrZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5zZWxlY3RlZFRhZ3MuYWRkKHRhZyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5zZWxlY3RlZFRhZ3MuZGVsZXRlKHRhZyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHRoaXMuYXBwbHlGaWx0ZXJzKCk7XG4gICAgICAgICAgICAgICAgdGhpcy5yZW5kZXJCb2FyZCgpO1xuICAgICAgICAgICAgICAgIC8vIFVwZGF0ZSBjbGVhciBidXR0b24gdmlzaWJpbGl0eVxuICAgICAgICAgICAgICAgIGNvbnN0IGNsZWFyQnRuID0gdGhpcy5jb250YWluZXJFbC5xdWVyeVNlbGVjdG9yKCcudGFzay1ib2FyZC1jbGVhci1maWx0ZXJzJykgYXMgSFRNTEVsZW1lbnQ7XG4gICAgICAgICAgICAgICAgaWYgKGNsZWFyQnRuKSB7XG4gICAgICAgICAgICAgICAgICAgIGNsZWFyQnRuLnN0eWxlLmRpc3BsYXkgPSB0aGlzLnNlbGVjdGVkVGFncy5zaXplID4gMCA/ICdpbmxpbmUtYmxvY2snIDogJ25vbmUnO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmVuZGVyQm9hcmQoKSB7XG4gICAgICAgIC8vIFJlbW92ZSBleGlzdGluZyBib2FyZCBpZiBhbnlcbiAgICAgICAgY29uc3QgZXhpc3RpbmdCb2FyZCA9IHRoaXMuY29udGFpbmVyRWwucXVlcnlTZWxlY3RvcignLnRhc2stYm9hcmQnKTtcbiAgICAgICAgaWYgKGV4aXN0aW5nQm9hcmQpIGV4aXN0aW5nQm9hcmQucmVtb3ZlKCk7XG5cbiAgICAgICAgY29uc3QgYm9hcmQgPSB0aGlzLmNvbnRhaW5lckVsLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stYm9hcmQnIH0pO1xuXG4gICAgICAgIC8vIFVzZSBwcmUtZmlsdGVyZWQgdGFza3MgKHNlYXJjaCArIHRhZyBmaWx0ZXJzIGFscmVhZHkgYXBwbGllZClcbiAgICAgICAgY29uc3QgdGFza3NUb1JlbmRlciA9IHRoaXMuZmlsdGVyZWRUYXNrcztcblxuICAgICAgICAvLyBHcm91cCB0YXNrcyBieSBzdGF0dXNcbiAgICAgICAgY29uc3QgdGFza3NCeVN0YXR1cyA9IG5ldyBNYXA8c3RyaW5nLCBUYXNrW10+KCk7XG4gICAgICAgIFxuICAgICAgICAvLyBJbml0aWFsaXplIHdpdGggY29uZmlndXJlZCBzdGF0dXMgb3JkZXJcbiAgICAgICAgZm9yIChjb25zdCBzdGF0dXMgb2YgdGhpcy5wbHVnaW4uc2V0dGluZ3Muc3RhdHVzT3JkZXIpIHtcbiAgICAgICAgICAgIHRhc2tzQnlTdGF0dXMuc2V0KHN0YXR1cywgW10pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gR3JvdXAgdGFza3NcbiAgICAgICAgZm9yIChjb25zdCB0YXNrIG9mIHRhc2tzVG9SZW5kZXIpIHtcbiAgICAgICAgICAgIGNvbnN0IHN0YXR1cyA9IHRhc2suc3RhdHVzIHx8IHRoaXMucGx1Z2luLnNldHRpbmdzLmRlZmF1bHRTdGF0dXM7XG4gICAgICAgICAgICBpZiAoIXRhc2tzQnlTdGF0dXMuaGFzKHN0YXR1cykpIHtcbiAgICAgICAgICAgICAgICB0YXNrc0J5U3RhdHVzLnNldChzdGF0dXMsIFtdKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRhc2tzQnlTdGF0dXMuZ2V0KHN0YXR1cykhLnB1c2godGFzayk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBDcmVhdGUgY29sdW1ucyAoc2tpcCBoaWRkZW4gc3RhdHVzZXMpXG4gICAgICAgIGZvciAoY29uc3Qgc3RhdHVzIG9mIHRoaXMucGx1Z2luLnNldHRpbmdzLnN0YXR1c09yZGVyKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5oaWRkZW5TdGF0dXNlcy5oYXMoc3RhdHVzKSkgY29udGludWU7XG4gICAgICAgICAgICBjb25zdCB0YXNrcyA9IHRhc2tzQnlTdGF0dXMuZ2V0KHN0YXR1cykgfHwgW107XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIEZvciBhY3RpdmUgY29sdW1ucyAodG9kbywgaW4tcHJvZ3Jlc3MpLCB1c2UgaGllcmFyY2hpY2FsIGdyb3VwaW5nXG4gICAgICAgICAgICBpZiAoc3RhdHVzID09PSAndG9kbycgfHwgc3RhdHVzID09PSAnaW4tcHJvZ3Jlc3MnKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5yZW5kZXJIaWVyYXJjaGljYWxDb2x1bW4oYm9hcmQsIHN0YXR1cywgdGFza3MpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyBTb3J0IGFuZCByZW5kZXIgZmxhdCBmb3IgZG9uZS9hcmNoaXZlIGNvbHVtbnNcbiAgICAgICAgICAgICAgICB0aGlzLnNvcnRUYXNrcyh0YXNrcyk7XG4gICAgICAgICAgICAgICAgdGhpcy5yZW5kZXJDb2x1bW4oYm9hcmQsIHN0YXR1cywgdGFza3MpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gR3JvdXAgdGFza3MgYnkgZm9sZGVyLCB0aGVuIGJ5IHRhZ1xuICAgIGdyb3VwVGFza3NIaWVyYXJjaGljYWxseSh0YXNrczogVGFza1tdKTogTWFwPHN0cmluZywgTWFwPHN0cmluZywgVGFza1tdPj4ge1xuICAgICAgICBjb25zdCBmb2xkZXJHcm91cHMgPSBuZXcgTWFwPHN0cmluZywgTWFwPHN0cmluZywgVGFza1tdPj4oKTtcblxuICAgICAgICBmb3IgKGNvbnN0IHRhc2sgb2YgdGFza3MpIHtcbiAgICAgICAgICAgIGNvbnN0IGZvbGRlciA9IHRhc2suZm9sZGVyIHx8ICdVbmNhdGVnb3JpemVkJztcbiAgICAgICAgICAgIGNvbnN0IHRhZyA9IHRhc2sudGFnIHx8ICd1bnRhZ2dlZCc7XG5cbiAgICAgICAgICAgIGlmICghZm9sZGVyR3JvdXBzLmhhcyhmb2xkZXIpKSB7XG4gICAgICAgICAgICAgICAgZm9sZGVyR3JvdXBzLnNldChmb2xkZXIsIG5ldyBNYXAoKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCB0YWdHcm91cHMgPSBmb2xkZXJHcm91cHMuZ2V0KGZvbGRlcikhO1xuXG4gICAgICAgICAgICBpZiAoIXRhZ0dyb3Vwcy5oYXModGFnKSkge1xuICAgICAgICAgICAgICAgIHRhZ0dyb3Vwcy5zZXQodGFnLCBbXSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0YWdHcm91cHMuZ2V0KHRhZykhLnB1c2godGFzayk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBTb3J0IHRhc2tzIHdpdGhpbiBlYWNoIHRhZyBncm91cFxuICAgICAgICBmb3IgKGNvbnN0IFtmb2xkZXIsIHRhZ0dyb3Vwc10gb2YgZm9sZGVyR3JvdXBzKSB7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IFt0YWcsIHRhZ1Rhc2tzXSBvZiB0YWdHcm91cHMpIHtcbiAgICAgICAgICAgICAgICB0aGlzLnNvcnRUYXNrcyh0YWdUYXNrcyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gZm9sZGVyR3JvdXBzO1xuICAgIH1cblxuICAgIHJlbmRlckhpZXJhcmNoaWNhbENvbHVtbihib2FyZDogSFRNTEVsZW1lbnQsIHN0YXR1czogc3RyaW5nLCB0YXNrczogVGFza1tdKSB7XG4gICAgICAgIGNvbnN0IGNvbHVtbiA9IGJvYXJkLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stYm9hcmQtY29sdW1uIGhpZXJhcmNoaWNhbCcgfSk7XG4gICAgICAgIGNvbHVtbi5zZXRBdHRyaWJ1dGUoJ2RhdGEtc3RhdHVzJywgc3RhdHVzKTtcblxuICAgICAgICAvLyBHcm91cCB0YXNrcyBoaWVyYXJjaGljYWxseVxuICAgICAgICBjb25zdCBmb2xkZXJHcm91cHMgPSB0aGlzLmdyb3VwVGFza3NIaWVyYXJjaGljYWxseSh0YXNrcyk7XG5cbiAgICAgICAgLy8gQ2FsY3VsYXRlIGR5bmFtaWMgd2lkdGggYmFzZWQgb24gbnVtYmVyIG9mIHRhZ3MgYW5kIGZvbGRlcnNcbiAgICAgICAgY29uc3QgY29sdW1uV2lkdGggPSB0aGlzLmNhbGN1bGF0ZUNvbHVtbldpZHRoKGZvbGRlckdyb3Vwcyk7XG4gICAgICAgIGNvbHVtbi5zdHlsZS53aWR0aCA9IGAke2NvbHVtbldpZHRofXB4YDtcbiAgICAgICAgY29sdW1uLnN0eWxlLm1pbldpZHRoID0gYCR7Y29sdW1uV2lkdGh9cHhgO1xuICAgICAgICBjb2x1bW4uc3R5bGUuZmxleCA9IGAwIDAgJHtjb2x1bW5XaWR0aH1weGA7XG5cbiAgICAgICAgLy8gQ29sdW1uIGhlYWRlciB3aXRoIGRyb3Agem9uZSBmb3Igc3RhdHVzIGNoYW5nZVxuICAgICAgICBjb25zdCBoZWFkZXIgPSBjb2x1bW4uY3JlYXRlRGl2KHsgY2xzOiAndGFzay1jb2x1bW4taGVhZGVyJyB9KTtcbiAgICAgICAgY29uc3Qgc3RhdHVzTGFiZWwgPSB0aGlzLmdldFN0YXR1c0xhYmVsKHN0YXR1cyk7XG4gICAgICAgIGhlYWRlci5jcmVhdGVFbCgnaDMnLCB7IHRleHQ6IHN0YXR1c0xhYmVsLCBjbHM6IGB0YXNrLWNvbHVtbi10aXRsZSBzdGF0dXMtJHtzdGF0dXN9YCB9KTtcbiAgICAgICAgaGVhZGVyLmNyZWF0ZVNwYW4oeyB0ZXh0OiBgJHt0YXNrcy5sZW5ndGh9YCwgY2xzOiAndGFzay1jb3VudCcgfSk7XG4gICAgICAgIFxuICAgICAgICAvLyBNYWtlIGVudGlyZSBjb2x1bW4gYSBkcm9wIHpvbmUgZm9yIHN0YXR1c1xuICAgICAgICB0aGlzLnNldHVwRHJvcFpvbmUoY29sdW1uLCAnc3RhdHVzJywgc3RhdHVzKTtcblxuICAgICAgICAvLyBUYXNrcyBjb250YWluZXIgd2l0aCBob3Jpem9udGFsIGxheW91dFxuICAgICAgICBjb25zdCB0YXNrc0NvbnRhaW5lciA9IGNvbHVtbi5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLWNvbHVtbi10YXNrcyBoaWVyYXJjaGljYWwnIH0pO1xuXG4gICAgICAgIC8vIFNvcnQgZm9sZGVycyBhbHBoYWJldGljYWxseVxuICAgICAgICBjb25zdCBzb3J0ZWRGb2xkZXJzID0gQXJyYXkuZnJvbShmb2xkZXJHcm91cHMua2V5cygpKS5zb3J0KCk7XG5cbiAgICAgICAgLy8gUmVuZGVyIGVhY2ggZm9sZGVyXG4gICAgICAgIGZvciAoY29uc3QgZm9sZGVyTmFtZSBvZiBzb3J0ZWRGb2xkZXJzKSB7XG4gICAgICAgICAgICBjb25zdCB0YWdHcm91cHMgPSBmb2xkZXJHcm91cHMuZ2V0KGZvbGRlck5hbWUpITtcbiAgICAgICAgICAgIC8vIENhbGN1bGF0ZSBmb2xkZXIgc2VjdGlvbiB3aWR0aCBiYXNlZCBvbiB0YWdzXG4gICAgICAgICAgICBjb25zdCBmb2xkZXJXaWR0aCA9IHRoaXMuY2FsY3VsYXRlRm9sZGVyV2lkdGgodGFnR3JvdXBzKTtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyRm9sZGVyU2VjdGlvbih0YXNrc0NvbnRhaW5lciwgZm9sZGVyTmFtZSwgdGFnR3JvdXBzLCBmb2xkZXJXaWR0aCwgc3RhdHVzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEVtcHR5IHN0YXRlXG4gICAgICAgIGlmICh0YXNrcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgIHRhc2tzQ29udGFpbmVyLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stZW1wdHknLCB0ZXh0OiAnTm8gdGFza3MnIH0pO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gQ2FsY3VsYXRlIG9wdGltYWwgY29sdW1uIHdpZHRoIGJhc2VkIG9uIGZvbGRlciBhbmQgdGFnIGNvdW50c1xuICAgIGNhbGN1bGF0ZUNvbHVtbldpZHRoKGZvbGRlckdyb3VwczogTWFwPHN0cmluZywgTWFwPHN0cmluZywgVGFza1tdPj4pOiBudW1iZXIge1xuICAgICAgICBjb25zdCBUQUdfV0lEVEggPSAyMDA7ICAgICAgLy8gV2lkdGggcGVyIHRhZyBncm91cCAoaW5jbHVkaW5nIHBhZGRpbmcgJiBib3JkZXIpXG4gICAgICAgIGNvbnN0IFRBR19HQVAgPSAxMjsgICAgICAgICAvLyBHYXAgYmV0d2VlbiB0YWdzXG4gICAgICAgIGNvbnN0IFNFQ1RJT05fUEFERElORyA9IDQ4OyAvLyBGb2xkZXIgc2VjdGlvbiBpbnRlcm5hbCBwYWRkaW5nICgxNnB4ICogMiArIG1hcmdpbilcbiAgICAgICAgY29uc3QgQ09MVU1OX1BBRERJTkcgPSA0ODsgIC8vIENvbHVtbiBjb250ZW50IHBhZGRpbmcgKDEycHggKiAyICsgZXh0cmEpXG4gICAgICAgIGNvbnN0IE1JTl9XSURUSCA9IDQwMDsgICAgICAvLyBNaW5pbXVtIGNvbHVtbiB3aWR0aFxuXG4gICAgICAgIGxldCBtYXhGb2xkZXJXaWR0aCA9IDA7XG5cbiAgICAgICAgLy8gQ2FsY3VsYXRlIHdpZHRoIGZvciBlYWNoIGZvbGRlciAoYWxsIHRhZ3MgaW4gb25lIGxpbmUpXG4gICAgICAgIGZvciAoY29uc3QgW2ZvbGRlciwgdGFnR3JvdXBzXSBvZiBmb2xkZXJHcm91cHMpIHtcbiAgICAgICAgICAgIGNvbnN0IHRhZ0NvdW50ID0gdGFnR3JvdXBzLnNpemU7XG4gICAgICAgICAgICAvLyBBY2NvdW50IGZvciB0YWdzLCBnYXBzIGJldHdlZW4gdGhlbSwgYW5kIGNvbnRhaW5lciBwYWRkaW5nXG4gICAgICAgICAgICBjb25zdCBjb250ZW50V2lkdGggPSAodGFnQ291bnQgKiBUQUdfV0lEVEgpICsgKCh0YWdDb3VudCAtIDEpICogVEFHX0dBUCk7XG4gICAgICAgICAgICBjb25zdCBmb2xkZXJXaWR0aCA9IGNvbnRlbnRXaWR0aCArIFNFQ1RJT05fUEFERElORztcbiAgICAgICAgICAgIG1heEZvbGRlcldpZHRoID0gTWF0aC5tYXgobWF4Rm9sZGVyV2lkdGgsIGZvbGRlcldpZHRoKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFJldHVybiB0aGUgd2lkdGggbmVlZGVkIGZvciB0aGUgd2lkZXN0IGZvbGRlciBwbHVzIGNvbHVtbiBwYWRkaW5nXG4gICAgICAgIHJldHVybiBNYXRoLm1heChNSU5fV0lEVEgsIG1heEZvbGRlcldpZHRoICsgQ09MVU1OX1BBRERJTkcpO1xuICAgIH1cblxuICAgIC8vIENhbGN1bGF0ZSBmb2xkZXIgc2VjdGlvbiB3aWR0aCAtIG1hdGNoZXMgY29sdW1uIHdpZHRoIGNhbGN1bGF0aW9uXG4gICAgY2FsY3VsYXRlRm9sZGVyV2lkdGgodGFnR3JvdXBzOiBNYXA8c3RyaW5nLCBUYXNrW10+KTogbnVtYmVyIHtcbiAgICAgICAgY29uc3QgVEFHX1dJRFRIID0gMjAwO1xuICAgICAgICBjb25zdCBUQUdfR0FQID0gMTI7XG4gICAgICAgIGNvbnN0IFBBRERJTkcgPSA0ODtcblxuICAgICAgICBjb25zdCB0YWdDb3VudCA9IHRhZ0dyb3Vwcy5zaXplO1xuICAgICAgICBjb25zdCBjb250ZW50V2lkdGggPSAodGFnQ291bnQgKiBUQUdfV0lEVEgpICsgKCh0YWdDb3VudCAtIDEpICogVEFHX0dBUCk7XG4gICAgICAgIHJldHVybiBjb250ZW50V2lkdGggKyBQQURESU5HO1xuICAgIH1cblxuICAgIHJlbmRlckZvbGRlclNlY3Rpb24oY29udGFpbmVyOiBIVE1MRWxlbWVudCwgZm9sZGVyTmFtZTogc3RyaW5nLCB0YWdHcm91cHM6IE1hcDxzdHJpbmcsIFRhc2tbXT4sIHdpZHRoPzogbnVtYmVyLCBzdGF0dXM/OiBzdHJpbmcpIHtcbiAgICAgICAgY29uc3QgZm9sZGVyU2VjdGlvbiA9IGNvbnRhaW5lci5jcmVhdGVEaXYoeyBjbHM6ICdmb2xkZXItc2VjdGlvbicgfSk7XG4gICAgICAgIGZvbGRlclNlY3Rpb24uc2V0QXR0cmlidXRlKCdkYXRhLWZvbGRlcicsIGZvbGRlck5hbWUpO1xuICAgICAgICBcbiAgICAgICAgLy8gQXBwbHkgY2FsY3VsYXRlZCB3aWR0aCBpZiBwcm92aWRlZFxuICAgICAgICBpZiAod2lkdGggJiYgd2lkdGggPiAwKSB7XG4gICAgICAgICAgICBmb2xkZXJTZWN0aW9uLnN0eWxlLndpZHRoID0gYCR7d2lkdGh9cHhgO1xuICAgICAgICAgICAgZm9sZGVyU2VjdGlvbi5zdHlsZS5taW5XaWR0aCA9IGAke3dpZHRofXB4YDtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEZvbGRlciBoZWFkZXIgd2l0aCBkcm9wIGluZGljYXRvciBhbmQgKyBidXR0b25cbiAgICAgICAgY29uc3QgZm9sZGVySGVhZGVyID0gZm9sZGVyU2VjdGlvbi5jcmVhdGVEaXYoeyBjbHM6ICdmb2xkZXItaGVhZGVyJyB9KTtcbiAgICAgICAgY29uc3QgZm9sZGVyVGl0bGVDb250YWluZXIgPSBmb2xkZXJIZWFkZXIuY3JlYXRlRGl2KHsgY2xzOiAnZm9sZGVyLXRpdGxlLWNvbnRhaW5lcicgfSk7XG4gICAgICAgIGZvbGRlclRpdGxlQ29udGFpbmVyLmNyZWF0ZUVsKCdoNCcsIHsgdGV4dDogZm9sZGVyTmFtZSwgY2xzOiAnZm9sZGVyLXRpdGxlJyB9KTtcbiAgICAgICAgXG4gICAgICAgIC8vIEFkZCBcIitcIiBidXR0b24gbmV4dCB0byBmb2xkZXIgbmFtZVxuICAgICAgICBjb25zdCBhZGRUYWdCdG4gPSBmb2xkZXJUaXRsZUNvbnRhaW5lci5jcmVhdGVFbCgnYnV0dG9uJywge1xuICAgICAgICAgICAgY2xzOiAnYWRkLXRhZy1idG4taGVhZGVyJyxcbiAgICAgICAgICAgIHRleHQ6ICcrJyxcbiAgICAgICAgICAgIGF0dHI6IHsgdGl0bGU6ICdBZGQgbmV3IHRhZycgfVxuICAgICAgICB9KTtcbiAgICAgICAgYWRkVGFnQnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICAgICAgdGhpcy5zaG93TmV3VGFnRGlhbG9nKGZvbGRlck5hbWUpO1xuICAgICAgICB9KTtcbiAgICAgICAgXG4gICAgICAgIGNvbnN0IHRvdGFsVGFza3MgPSBBcnJheS5mcm9tKHRhZ0dyb3Vwcy52YWx1ZXMoKSkucmVkdWNlKChzdW0sIHRhc2tzKSA9PiBzdW0gKyB0YXNrcy5sZW5ndGgsIDApO1xuICAgICAgICBmb2xkZXJIZWFkZXIuY3JlYXRlU3Bhbih7IHRleHQ6IGAke3RvdGFsVGFza3N9YCwgY2xzOiAnZm9sZGVyLWNvdW50JyB9KTtcblxuICAgICAgICAvLyBIb3Jpem9udGFsIGNvbnRhaW5lciBmb3IgdGFnIGdyb3Vwc1xuICAgICAgICBjb25zdCB0YWdzQ29udGFpbmVyID0gZm9sZGVyU2VjdGlvbi5jcmVhdGVEaXYoeyBjbHM6ICd0YWdzLWNvbnRhaW5lcicgfSk7XG5cbiAgICAgICAgLy8gU29ydCB0YWdzIGFscGhhYmV0aWNhbGx5XG4gICAgICAgIGNvbnN0IHNvcnRlZFRhZ3MgPSBBcnJheS5mcm9tKHRhZ0dyb3Vwcy5rZXlzKCkpLnNvcnQoKTtcblxuICAgICAgICAvLyBSZW5kZXIgZWFjaCB0YWcgZ3JvdXBcbiAgICAgICAgZm9yIChjb25zdCB0YWcgb2Ygc29ydGVkVGFncykge1xuICAgICAgICAgICAgY29uc3QgdGFza3MgPSB0YWdHcm91cHMuZ2V0KHRhZykhO1xuICAgICAgICAgICAgdGhpcy5yZW5kZXJUYWdHcm91cCh0YWdzQ29udGFpbmVyLCBmb2xkZXJOYW1lLCB0YWcsIHRhc2tzKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJlbmRlclRhZ0dyb3VwKGNvbnRhaW5lcjogSFRNTEVsZW1lbnQsIGZvbGRlck5hbWU6IHN0cmluZywgdGFnOiBzdHJpbmcsIHRhc2tzOiBUYXNrW10pIHtcbiAgICAgICAgY29uc3QgdGFnR3JvdXAgPSBjb250YWluZXIuY3JlYXRlRGl2KHsgY2xzOiAndGFnLWdyb3VwJyB9KTtcbiAgICAgICAgdGFnR3JvdXAuc2V0QXR0cmlidXRlKCdkYXRhLXRhZycsIHRhZyk7XG5cbiAgICAgICAgLy8gVGFnIGhlYWRlclxuICAgICAgICBjb25zdCB0YWdIZWFkZXIgPSB0YWdHcm91cC5jcmVhdGVEaXYoeyBjbHM6ICd0YWctaGVhZGVyJyB9KTtcbiAgICAgICAgdGFnSGVhZGVyLmNyZWF0ZVNwYW4oeyB0ZXh0OiB0YWcsIGNsczogJ3RhZy1ncm91cC1uYW1lJyB9KTtcbiAgICAgICAgdGFnSGVhZGVyLmNyZWF0ZVNwYW4oeyB0ZXh0OiBgJHt0YXNrcy5sZW5ndGh9YCwgY2xzOiAndGFnLWdyb3VwLWNvdW50JyB9KTtcblxuICAgICAgICAvLyBUYXNrcyBpbiB0aGlzIHRhZyBncm91cCB3aXRoIGRyb3Agem9uZSBmb3IgdGFnIGNoYW5nZXNcbiAgICAgICAgY29uc3QgdGFza3NDb250YWluZXIgPSB0YWdHcm91cC5jcmVhdGVEaXYoeyBjbHM6ICd0YWctdGFza3MnIH0pO1xuICAgICAgICB0aGlzLnNldHVwRHJvcFpvbmUodGFza3NDb250YWluZXIsICd0YWcnLCB0YWcpO1xuXG4gICAgICAgIGZvciAoY29uc3QgdGFzayBvZiB0YXNrcykge1xuICAgICAgICAgICAgdGhpcy5yZW5kZXJUYXNrQ2FyZCh0YXNrc0NvbnRhaW5lciwgdGFzayk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBcIk5ld1wiIGJ1dHRvbiBhdCB0aGUgZW5kIG9mIHRhZyBncm91cFxuICAgICAgICBjb25zdCBuZXdUYXNrQnRuID0gdGFnR3JvdXAuY3JlYXRlRWwoJ2J1dHRvbicsIHtcbiAgICAgICAgICAgIGNsczogJ25ldy10YXNrLWJ0bicsXG4gICAgICAgICAgICB0ZXh0OiAnTmV3J1xuICAgICAgICB9KTtcbiAgICAgICAgbmV3VGFza0J0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgICAgIHRoaXMuc2hvd05ld1Rhc2tEaWFsb2coZm9sZGVyTmFtZSwgdGFnKTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgc29ydFRhc2tzKHRhc2tzOiBUYXNrW10pIHtcbiAgICAgICAgY29uc3Qgc29ydEJ5ID0gdGhpcy5wbHVnaW4uc2V0dGluZ3Muc29ydEJ5O1xuICAgICAgICBjb25zdCBkaXJlY3Rpb24gPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zb3J0RGlyZWN0aW9uO1xuICAgICAgICBjb25zdCBtdWx0aXBsaWVyID0gZGlyZWN0aW9uID09PSAnYXNjJyA/IDEgOiAtMTtcblxuICAgICAgICB0YXNrcy5zb3J0KChhLCBiKSA9PiB7XG4gICAgICAgICAgICBsZXQgY29tcGFyaXNvbiA9IDA7XG5cbiAgICAgICAgICAgIHN3aXRjaCAoc29ydEJ5KSB7XG4gICAgICAgICAgICAgICAgY2FzZSAncHJpb3JpdHknOlxuICAgICAgICAgICAgICAgICAgICBjb25zdCBwcmlvcml0eU1hcCA9IHsgaGlnaDogMywgbWVkaXVtOiAyLCBsb3c6IDEgfTtcbiAgICAgICAgICAgICAgICAgICAgY29tcGFyaXNvbiA9IHByaW9yaXR5TWFwW2EucHJpb3JpdHldIC0gcHJpb3JpdHlNYXBbYi5wcmlvcml0eV07XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGNhc2UgJ3RhZyc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBhcmlzb24gPSBhLnRhZy5sb2NhbGVDb21wYXJlKGIudGFnKTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgY2FzZSAndGl0bGUnOlxuICAgICAgICAgICAgICAgICAgICBjb21wYXJpc29uID0gYS50aXRsZS5sb2NhbGVDb21wYXJlKGIudGl0bGUpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlICdmb2xkZXInOlxuICAgICAgICAgICAgICAgICAgICBjb21wYXJpc29uID0gYS5mb2xkZXIubG9jYWxlQ29tcGFyZShiLmZvbGRlcik7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gY29tcGFyaXNvbiAqIG11bHRpcGxpZXI7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIHJlbmRlckNvbHVtbihib2FyZDogSFRNTEVsZW1lbnQsIHN0YXR1czogc3RyaW5nLCB0YXNrczogVGFza1tdKSB7XG4gICAgICAgIGNvbnN0IGNvbHVtbiA9IGJvYXJkLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stYm9hcmQtY29sdW1uJyB9KTtcbiAgICAgICAgY29sdW1uLnNldEF0dHJpYnV0ZSgnZGF0YS1zdGF0dXMnLCBzdGF0dXMpO1xuXG4gICAgICAgIC8vIENvbHVtbiBoZWFkZXJcbiAgICAgICAgY29uc3QgaGVhZGVyID0gY29sdW1uLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stY29sdW1uLWhlYWRlcicgfSk7XG4gICAgICAgIGNvbnN0IHN0YXR1c0xhYmVsID0gdGhpcy5nZXRTdGF0dXNMYWJlbChzdGF0dXMpO1xuICAgICAgICBoZWFkZXIuY3JlYXRlRWwoJ2gzJywgeyB0ZXh0OiBzdGF0dXNMYWJlbCwgY2xzOiBgdGFzay1jb2x1bW4tdGl0bGUgc3RhdHVzLSR7c3RhdHVzfWAgfSk7XG4gICAgICAgIGhlYWRlci5jcmVhdGVTcGFuKHsgdGV4dDogYCR7dGFza3MubGVuZ3RofWAsIGNsczogJ3Rhc2stY291bnQnIH0pO1xuXG4gICAgICAgIC8vIFRhc2tzIGNvbnRhaW5lciB3aXRoIGRyb3Agem9uZVxuICAgICAgICBjb25zdCB0YXNrc0NvbnRhaW5lciA9IGNvbHVtbi5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLWNvbHVtbi10YXNrcycgfSk7XG4gICAgICAgIHRoaXMuc2V0dXBEcm9wWm9uZSh0YXNrc0NvbnRhaW5lciwgJ3N0YXR1cycsIHN0YXR1cyk7XG5cbiAgICAgICAgLy8gUmVuZGVyIHRhc2tzXG4gICAgICAgIGZvciAoY29uc3QgdGFzayBvZiB0YXNrcykge1xuICAgICAgICAgICAgdGhpcy5yZW5kZXJUYXNrQ2FyZCh0YXNrc0NvbnRhaW5lciwgdGFzayk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBTZXR1cCBkcm9wIHpvbmUgZm9yIGRyYWcgYW5kIGRyb3BcbiAgICBzZXR1cERyb3Bab25lKGVsZW1lbnQ6IEhUTUxFbGVtZW50LCB0eXBlOiAnc3RhdHVzJyB8ICd0YWcnIHwgJ2ZvbGRlcicsIHZhbHVlOiBzdHJpbmcsIGZvbGRlcj86IFRGb2xkZXIpIHtcbiAgICAgICAgZWxlbWVudC5hZGRFdmVudExpc3RlbmVyKCdkcmFnb3ZlcicsIChlKSA9PiB7XG4gICAgICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgICAgICBlbGVtZW50LmNsYXNzTGlzdC5hZGQoJ2Ryb3AtdGFyZ2V0Jyk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGVsZW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignZHJhZ2xlYXZlJywgKCkgPT4ge1xuICAgICAgICAgICAgZWxlbWVudC5jbGFzc0xpc3QucmVtb3ZlKCdkcm9wLXRhcmdldCcpO1xuICAgICAgICB9KTtcblxuICAgICAgICBlbGVtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2Ryb3AnLCBhc3luYyAoZSkgPT4ge1xuICAgICAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICAgICAgZWxlbWVudC5jbGFzc0xpc3QucmVtb3ZlKCdkcm9wLXRhcmdldCcpO1xuXG4gICAgICAgICAgICBjb25zdCB0YXNrSWQgPSBlLmRhdGFUcmFuc2Zlcj8uZ2V0RGF0YSgndGV4dC9wbGFpbicpO1xuICAgICAgICAgICAgaWYgKCF0YXNrSWQpIHJldHVybjtcblxuICAgICAgICAgICAgY29uc3QgdGFzayA9IHRoaXMudGFza3MuZmluZCh0ID0+IHQuaWQgPT09IHRhc2tJZCk7XG4gICAgICAgICAgICBpZiAoIXRhc2spIHJldHVybjtcblxuICAgICAgICAgICAgLy8gUHJldmVudCBkcm9wcGluZyBvbiBzYW1lIGxvY2F0aW9uXG4gICAgICAgICAgICBpZiAodHlwZSA9PT0gJ3N0YXR1cycgJiYgdGFzay5zdGF0dXMgPT09IHZhbHVlKSByZXR1cm47XG4gICAgICAgICAgICBpZiAodHlwZSA9PT0gJ3RhZycgJiYgdGFzay50YWcgPT09IHZhbHVlKSByZXR1cm47XG4gICAgICAgICAgICBpZiAodHlwZSA9PT0gJ2ZvbGRlcicgJiYgZm9sZGVyICYmIHRhc2suZmlsZS5wYXJlbnQ/LnBhdGggPT09IGZvbGRlci5wYXRoKSByZXR1cm47XG5cbiAgICAgICAgICAgIC8vIFBlcmZvcm0gdGhlIG1vdmVcbiAgICAgICAgICAgIGlmICh0eXBlID09PSAnc3RhdHVzJykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnVwZGF0ZVRhc2tTdGF0dXModGFzaywgdmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmICh0eXBlID09PSAndGFnJykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnVwZGF0ZVRhc2sodGFzaywgdmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmICh0eXBlID09PSAnZm9sZGVyJyAmJiBmb2xkZXIpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5tb3ZlVGFza1RvRm9sZGVyKHRhc2ssIGZvbGRlcik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRoaXMucmVmcmVzaCgpO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICByZW5kZXJUYXNrQ2FyZChjb250YWluZXI6IEhUTUxFbGVtZW50LCB0YXNrOiBUYXNrKSB7XG4gICAgICAgIGNvbnN0IGNhcmQgPSBjb250YWluZXIuY3JlYXRlRGl2KHsgY2xzOiBgdGFzay1jYXJkIHByaW9yaXR5LSR7dGFzay5wcmlvcml0eX1gIH0pO1xuICAgICAgICBjYXJkLnNldEF0dHJpYnV0ZSgnZGF0YS10YXNrLWlkJywgdGFzay5pZCk7XG5cbiAgICAgICAgLy8gUHJpb3JpdHkgaW5kaWNhdG9yXG4gICAgICAgIGNvbnN0IHByaW9yaXR5RG90ID0gY2FyZC5jcmVhdGVEaXYoeyBjbHM6IGB0YXNrLXByaW9yaXR5IHByaW9yaXR5LSR7dGFzay5wcmlvcml0eX1gIH0pO1xuICAgICAgICBwcmlvcml0eURvdC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIChlKSA9PiB7XG4gICAgICAgICAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgICAgICAgICAgdGhpcy5zaG93UHJpb3JpdHlNZW51KHRhc2ssIHByaW9yaXR5RG90LCBlKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gVGFzayB0aXRsZVxuICAgICAgICBjb25zdCB0aXRsZSA9IGNhcmQuY3JlYXRlRGl2KHsgY2xzOiAndGFzay10aXRsZScgfSk7XG4gICAgICAgIHRpdGxlLmNyZWF0ZUVsKCdhJywge1xuICAgICAgICAgICAgdGV4dDogdGFzay50aXRsZSxcbiAgICAgICAgICAgIGhyZWY6ICcjJyxcbiAgICAgICAgICAgIGNsczogJ3Rhc2stbGluaydcbiAgICAgICAgfSkuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoZSkgPT4ge1xuICAgICAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLm9wZW5MaW5rVGV4dCh0YXNrLmZpbGUucGF0aCwgJycpO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBUYXNrIG1ldGFcbiAgICAgICAgY29uc3QgbWV0YSA9IGNhcmQuY3JlYXRlRGl2KHsgY2xzOiAndGFzay1tZXRhJyB9KTtcblxuICAgICAgICAvLyBUYWdcbiAgICAgICAgaWYgKHRhc2sudGFnICYmIHRhc2sudGFnICE9PSAndW50YWdnZWQnKSB7XG4gICAgICAgICAgICBtZXRhLmNyZWF0ZVNwYW4oeyB0ZXh0OiB0YXNrLnRhZywgY2xzOiAndGFzay10YWcnIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gRm9sZGVyXG4gICAgICAgIG1ldGEuY3JlYXRlU3Bhbih7IHRleHQ6IHRhc2suZm9sZGVyLCBjbHM6ICd0YXNrLWZvbGRlcicgfSk7XG5cbiAgICAgICAgLy8gU3RhdHVzIGNoYW5nZSBvbiBjYXJkIGNsaWNrXG4gICAgICAgIGNhcmQuYWRkRXZlbnRMaXN0ZW5lcignY29udGV4dG1lbnUnLCAoZSkgPT4ge1xuICAgICAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICAgICAgdGhpcy5zaG93U3RhdHVzTWVudSh0YXNrLCBlKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gRHJhZyBzdXBwb3J0IChkZXNrdG9wIG9ubHkgLSBIVE1MNSBkcmFnIGRvZXNuJ3Qgd29yayB3ZWxsIG9uIG1vYmlsZSlcbiAgICAgICAgY29uc3QgaXNNb2JpbGUgPSAvaVBob25lfGlQYWR8aVBvZHxBbmRyb2lkL2kudGVzdChuYXZpZ2F0b3IudXNlckFnZW50KTtcbiAgICAgICAgaWYgKCFpc01vYmlsZSkge1xuICAgICAgICAgICAgY2FyZC5kcmFnZ2FibGUgPSB0cnVlO1xuICAgICAgICAgICAgY2FyZC5hZGRFdmVudExpc3RlbmVyKCdkcmFnc3RhcnQnLCAoZSkgPT4ge1xuICAgICAgICAgICAgICAgIGUuZGF0YVRyYW5zZmVyPy5zZXREYXRhKCd0ZXh0L3BsYWluJywgdGFzay5pZCk7XG4gICAgICAgICAgICAgICAgZS5kYXRhVHJhbnNmZXI/LnNldERhdGEoJ3Rhc2svdGFnJywgdGFzay50YWcpO1xuICAgICAgICAgICAgICAgIGUuZGF0YVRyYW5zZmVyPy5zZXREYXRhKCd0YXNrL2ZvbGRlcicsIHRhc2suZm9sZGVyKTtcbiAgICAgICAgICAgICAgICBjYXJkLmNsYXNzTGlzdC5hZGQoJ2RyYWdnaW5nJyk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGNhcmQuYWRkRXZlbnRMaXN0ZW5lcignZHJhZ2VuZCcsICgpID0+IHtcbiAgICAgICAgICAgICAgICBjYXJkLmNsYXNzTGlzdC5yZW1vdmUoJ2RyYWdnaW5nJyk7XG4gICAgICAgICAgICAgICAgLy8gUmVtb3ZlIGFsbCBkcm9wLXRhcmdldCBoaWdobGlnaHRzIChzYWZlbHkpXG4gICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBkb2N1bWVudCAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kcm9wLXRhcmdldCcpLmZvckVhY2goZWwgPT4gZWwuY2xhc3NMaXN0LnJlbW92ZSgnZHJvcC10YXJnZXQnKSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIElnbm9yZSBkb2N1bWVudCBlcnJvcnMgb24gbW9iaWxlXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzaG93UHJpb3JpdHlNZW51KHRhc2s6IFRhc2ssIGVsZW1lbnQ6IEhUTUxFbGVtZW50LCBldnQ6IE1vdXNlRXZlbnQpIHtcbiAgICAgICAgY29uc3QgbWVudSA9IG5ldyBNZW51KCk7XG4gICAgICAgIFxuICAgICAgICBjb25zdCBwcmlvcml0aWVzID0gWydoaWdoJywgJ21lZGl1bScsICdsb3cnXSBhcyBjb25zdDtcbiAgICAgICAgZm9yIChjb25zdCBwcmlvcml0eSBvZiBwcmlvcml0aWVzKSB7XG4gICAgICAgICAgICBtZW51LmFkZEl0ZW0oKGl0ZW0pID0+IHtcbiAgICAgICAgICAgICAgICBpdGVtLnNldFRpdGxlKHByaW9yaXR5LmNoYXJBdCgwKS50b1VwcGVyQ2FzZSgpICsgcHJpb3JpdHkuc2xpY2UoMSkpXG4gICAgICAgICAgICAgICAgICAgIC5zZXRJY29uKHRhc2sucHJpb3JpdHkgPT09IHByaW9yaXR5ID8gJ2NoZWNrJyA6ICcnKVxuICAgICAgICAgICAgICAgICAgICAub25DbGljayhhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi51cGRhdGVUYXNrUHJpb3JpdHkodGFzaywgcHJpb3JpdHkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5yZWZyZXNoKCk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBtZW51LnNob3dBdE1vdXNlRXZlbnQoZXZ0KTtcbiAgICB9XG5cbiAgICBzaG93U3RhdHVzTWVudSh0YXNrOiBUYXNrLCBldnQ6IE1vdXNlRXZlbnQpIHtcbiAgICAgICAgY29uc3QgbWVudSA9IG5ldyBNZW51KCk7XG4gICAgICAgIFxuICAgICAgICBmb3IgKGNvbnN0IHN0YXR1cyBvZiB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zdGF0dXNPcmRlcikge1xuICAgICAgICAgICAgbWVudS5hZGRJdGVtKChpdGVtKSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgbGFiZWwgPSB0aGlzLmdldFN0YXR1c0xhYmVsKHN0YXR1cyk7XG4gICAgICAgICAgICAgICAgaXRlbS5zZXRUaXRsZShsYWJlbClcbiAgICAgICAgICAgICAgICAgICAgLnNldEljb24odGFzay5zdGF0dXMgPT09IHN0YXR1cyA/ICdjaGVjaycgOiAnJylcbiAgICAgICAgICAgICAgICAgICAgLm9uQ2xpY2soYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4udXBkYXRlVGFza1N0YXR1cyh0YXNrLCBzdGF0dXMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5yZWZyZXNoKCk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBtZW51LnNob3dBdE1vdXNlRXZlbnQoZXZ0KTtcbiAgICB9XG5cbiAgICBnZXRTdGF0dXNMYWJlbChzdGF0dXM6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgICAgIGNvbnN0IGxhYmVsczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICAgICAgICAgICd0b2RvJzogJ1RvIERvJyxcbiAgICAgICAgICAgICdpbi1wcm9ncmVzcyc6ICdJbiBQcm9ncmVzcycsXG4gICAgICAgICAgICAnZG9uZSc6ICdEb25lJyxcbiAgICAgICAgICAgICdhcmNoaXZlJzogJ0FyY2hpdmUnXG4gICAgICAgIH07XG4gICAgICAgIHJldHVybiBsYWJlbHNbc3RhdHVzXSB8fCBzdGF0dXMuY2hhckF0KDApLnRvVXBwZXJDYXNlKCkgKyBzdGF0dXMuc2xpY2UoMSk7XG4gICAgfVxuXG4gICAgLy8gU2hvdyBkaWFsb2cgdG8gY3JlYXRlIGEgbmV3IHRhc2sgaW4gYSBzcGVjaWZpYyBmb2xkZXIgYW5kIHRhZ1xuICAgIHNob3dOZXdUYXNrRGlhbG9nKGZvbGRlck5hbWU6IHN0cmluZywgdGFnOiBzdHJpbmcpIHtcbiAgICAgICAgY29uc3QgbW9kYWwgPSBuZXcgTmV3VGFza01vZGFsKHRoaXMuYXBwLCBmb2xkZXJOYW1lLCB0YWcsICh0aXRsZSwgZm9sZGVyLCB0YXNrVGFnLCBwcmlvcml0eSkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uY3JlYXRlTmV3VGFzayh0aXRsZSwgZm9sZGVyLCB0YXNrVGFnLCBwcmlvcml0eSk7XG4gICAgICAgIH0pO1xuICAgICAgICBtb2RhbC5vcGVuKCk7XG4gICAgfVxuXG4gICAgLy8gU2hvdyBkaWFsb2cgdG8gY3JlYXRlIGEgbmV3IHRhZyB3aXRoIGEgVE9ETyBpdGVtXG4gICAgc2hvd05ld1RhZ0RpYWxvZyhmb2xkZXJOYW1lOiBzdHJpbmcpIHtcbiAgICAgICAgY29uc3QgbW9kYWwgPSBuZXcgTmV3VGFnTW9kYWwodGhpcy5hcHAsIGZvbGRlck5hbWUsICh0YWdOYW1lLCB0aXRsZSwgcHJpb3JpdHkpID0+IHtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLmNyZWF0ZU5ld1Rhc2sodGl0bGUsIGZvbGRlck5hbWUsIHRhZ05hbWUsIHByaW9yaXR5KTtcbiAgICAgICAgfSk7XG4gICAgICAgIG1vZGFsLm9wZW4oKTtcbiAgICB9XG59XG5cbi8vIE1vZGFsIGZvciBjcmVhdGluZyBhIG5ldyB0YXNrXG5jbGFzcyBOZXdUYXNrTW9kYWwgZXh0ZW5kcyBNb2RhbCB7XG4gICAgZm9sZGVyOiBzdHJpbmc7XG4gICAgdGFnOiBzdHJpbmc7XG4gICAgb25TdWJtaXQ6ICh0aXRsZTogc3RyaW5nLCBmb2xkZXI6IHN0cmluZywgdGFnOiBzdHJpbmcsIHByaW9yaXR5OiBzdHJpbmcpID0+IHZvaWQ7XG5cbiAgICBjb25zdHJ1Y3RvcihhcHA6IEFwcCwgZm9sZGVyOiBzdHJpbmcsIHRhZzogc3RyaW5nLCBvblN1Ym1pdDogKHRpdGxlOiBzdHJpbmcsIGZvbGRlcjogc3RyaW5nLCB0YWc6IHN0cmluZywgcHJpb3JpdHk6IHN0cmluZykgPT4gdm9pZCkge1xuICAgICAgICBzdXBlcihhcHApO1xuICAgICAgICB0aGlzLmZvbGRlciA9IGZvbGRlcjtcbiAgICAgICAgdGhpcy50YWcgPSB0YWc7XG4gICAgICAgIHRoaXMub25TdWJtaXQgPSBvblN1Ym1pdDtcbiAgICB9XG5cbiAgICBvbk9wZW4oKSB7XG4gICAgICAgIGNvbnN0IHsgY29udGVudEVsIH0gPSB0aGlzO1xuICAgICAgICBjb250ZW50RWwuY3JlYXRlRWwoJ2gyJywgeyB0ZXh0OiAnQ3JlYXRlIE5ldyBUYXNrJyB9KTtcblxuICAgICAgICAvLyBUaXRsZSBpbnB1dFxuICAgICAgICBjb250ZW50RWwuY3JlYXRlRWwoJ2xhYmVsJywgeyB0ZXh0OiAnVGFzayBUaXRsZTonIH0pO1xuICAgICAgICBjb25zdCB0aXRsZUlucHV0ID0gY29udGVudEVsLmNyZWF0ZUVsKCdpbnB1dCcsIHtcbiAgICAgICAgICAgIHR5cGU6ICd0ZXh0JyxcbiAgICAgICAgICAgIHBsYWNlaG9sZGVyOiAnRW50ZXIgdGFzayB0aXRsZS4uLidcbiAgICAgICAgfSk7XG4gICAgICAgIHRpdGxlSW5wdXQuc3R5bGUud2lkdGggPSAnMTAwJSc7XG4gICAgICAgIHRpdGxlSW5wdXQuc3R5bGUubWFyZ2luQm90dG9tID0gJzE2cHgnO1xuXG4gICAgICAgIC8vIEZvbGRlciBpbmZvXG4gICAgICAgIGNvbnRlbnRFbC5jcmVhdGVFbCgnbGFiZWwnLCB7IHRleHQ6ICdGb2xkZXI6JyB9KTtcbiAgICAgICAgY29udGVudEVsLmNyZWF0ZUVsKCdkaXYnLCB7IHRleHQ6IHRoaXMuZm9sZGVyLCBjbHM6ICduZXctdGFzay1pbmZvJyB9KTtcblxuICAgICAgICAvLyBUYWcgaW5mb1xuICAgICAgICBjb250ZW50RWwuY3JlYXRlRWwoJ2xhYmVsJywgeyB0ZXh0OiAnVGFnOicgfSk7XG4gICAgICAgIGNvbnRlbnRFbC5jcmVhdGVFbCgnZGl2JywgeyB0ZXh0OiB0aGlzLnRhZywgY2xzOiAnbmV3LXRhc2staW5mbycgfSk7XG5cbiAgICAgICAgLy8gUHJpb3JpdHkgc2VsZWN0aW9uXG4gICAgICAgIGNvbnRlbnRFbC5jcmVhdGVFbCgnbGFiZWwnLCB7IHRleHQ6ICdQcmlvcml0eTonIH0pO1xuICAgICAgICBjb25zdCBwcmlvcml0eVNlbGVjdCA9IGNvbnRlbnRFbC5jcmVhdGVFbCgnc2VsZWN0Jyk7XG4gICAgICAgIHByaW9yaXR5U2VsZWN0LnN0eWxlLndpZHRoID0gJzEwMCUnO1xuICAgICAgICBwcmlvcml0eVNlbGVjdC5zdHlsZS5tYXJnaW5Cb3R0b20gPSAnMTZweCc7XG4gICAgICAgIFsnaGlnaCcsICdtZWRpdW0nLCAnbG93J10uZm9yRWFjaChwID0+IHtcbiAgICAgICAgICAgIGNvbnN0IG9wdGlvbiA9IHByaW9yaXR5U2VsZWN0LmNyZWF0ZUVsKCdvcHRpb24nLCB7IHRleHQ6IHAsIHZhbHVlOiBwIH0pO1xuICAgICAgICAgICAgaWYgKHAgPT09ICdtZWRpdW0nKSBvcHRpb24uc2VsZWN0ZWQgPSB0cnVlO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBCdXR0b25zXG4gICAgICAgIGNvbnN0IGJ1dHRvbkNvbnRhaW5lciA9IGNvbnRlbnRFbC5jcmVhdGVEaXYoeyBjbHM6ICdtb2RhbC1idXR0b24tY29udGFpbmVyJyB9KTtcblxuICAgICAgICBjb25zdCBzdWJtaXRCdG4gPSBidXR0b25Db250YWluZXIuY3JlYXRlRWwoJ2J1dHRvbicsIHtcbiAgICAgICAgICAgIHRleHQ6ICdDcmVhdGUnLFxuICAgICAgICAgICAgY2xzOiAnbW9kLWN0YSdcbiAgICAgICAgfSk7XG4gICAgICAgIHN1Ym1pdEJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHRpdGxlID0gdGl0bGVJbnB1dC52YWx1ZS50cmltKCk7XG4gICAgICAgICAgICBpZiAodGl0bGUpIHtcbiAgICAgICAgICAgICAgICB0aGlzLm9uU3VibWl0KHRpdGxlLCB0aGlzLmZvbGRlciwgdGhpcy50YWcsIHByaW9yaXR5U2VsZWN0LnZhbHVlKTtcbiAgICAgICAgICAgICAgICB0aGlzLmNsb3NlKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGNvbnN0IGNhbmNlbEJ0biA9IGJ1dHRvbkNvbnRhaW5lci5jcmVhdGVFbCgnYnV0dG9uJywgeyB0ZXh0OiAnQ2FuY2VsJyB9KTtcbiAgICAgICAgY2FuY2VsQnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdGhpcy5jbG9zZSgpKTtcblxuICAgICAgICAvLyBGb2N1cyB0aXRsZSBpbnB1dFxuICAgICAgICB0aXRsZUlucHV0LmZvY3VzKCk7XG4gICAgfVxuXG4gICAgb25DbG9zZSgpIHtcbiAgICAgICAgY29uc3QgeyBjb250ZW50RWwgfSA9IHRoaXM7XG4gICAgICAgIGNvbnRlbnRFbC5lbXB0eSgpO1xuICAgIH1cbn1cblxuLy8gTW9kYWwgZm9yIGNyZWF0aW5nIGEgbmV3IHRhZ1xuY2xhc3MgTmV3VGFnTW9kYWwgZXh0ZW5kcyBNb2RhbCB7XG4gICAgZm9sZGVyOiBzdHJpbmc7XG4gICAgb25TdWJtaXQ6ICh0YWdOYW1lOiBzdHJpbmcsIHRpdGxlOiBzdHJpbmcsIHByaW9yaXR5OiBzdHJpbmcpID0+IHZvaWQ7XG5cbiAgICBjb25zdHJ1Y3RvcihhcHA6IEFwcCwgZm9sZGVyOiBzdHJpbmcsIG9uU3VibWl0OiAodGFnTmFtZTogc3RyaW5nLCB0aXRsZTogc3RyaW5nLCBwcmlvcml0eTogc3RyaW5nKSA9PiB2b2lkKSB7XG4gICAgICAgIHN1cGVyKGFwcCk7XG4gICAgICAgIHRoaXMuZm9sZGVyID0gZm9sZGVyO1xuICAgICAgICB0aGlzLm9uU3VibWl0ID0gb25TdWJtaXQ7XG4gICAgfVxuXG4gICAgb25PcGVuKCkge1xuICAgICAgICBjb25zdCB7IGNvbnRlbnRFbCB9ID0gdGhpcztcbiAgICAgICAgY29udGVudEVsLmNyZWF0ZUVsKCdoMicsIHsgdGV4dDogJ0NyZWF0ZSBOZXcgVGFnIHdpdGggVGFzaycgfSk7XG5cbiAgICAgICAgLy8gVGFnIG5hbWUgaW5wdXRcbiAgICAgICAgY29udGVudEVsLmNyZWF0ZUVsKCdsYWJlbCcsIHsgdGV4dDogJ1RhZyBOYW1lOicgfSk7XG4gICAgICAgIGNvbnN0IHRhZ0lucHV0ID0gY29udGVudEVsLmNyZWF0ZUVsKCdpbnB1dCcsIHtcbiAgICAgICAgICAgIHR5cGU6ICd0ZXh0JyxcbiAgICAgICAgICAgIHBsYWNlaG9sZGVyOiAnRW50ZXIgbmV3IHRhZyBuYW1lLi4uJ1xuICAgICAgICB9KTtcbiAgICAgICAgdGFnSW5wdXQuc3R5bGUud2lkdGggPSAnMTAwJSc7XG4gICAgICAgIHRhZ0lucHV0LnN0eWxlLm1hcmdpbkJvdHRvbSA9ICcxNnB4JztcblxuICAgICAgICAvLyBUYXNrIHRpdGxlIGlucHV0XG4gICAgICAgIGNvbnRlbnRFbC5jcmVhdGVFbCgnbGFiZWwnLCB7IHRleHQ6ICdUYXNrIFRpdGxlOicgfSk7XG4gICAgICAgIGNvbnN0IHRpdGxlSW5wdXQgPSBjb250ZW50RWwuY3JlYXRlRWwoJ2lucHV0Jywge1xuICAgICAgICAgICAgdHlwZTogJ3RleHQnLFxuICAgICAgICAgICAgcGxhY2Vob2xkZXI6ICdFbnRlciB0YXNrIHRpdGxlLi4uJ1xuICAgICAgICB9KTtcbiAgICAgICAgdGl0bGVJbnB1dC5zdHlsZS53aWR0aCA9ICcxMDAlJztcbiAgICAgICAgdGl0bGVJbnB1dC5zdHlsZS5tYXJnaW5Cb3R0b20gPSAnMTZweCc7XG5cbiAgICAgICAgLy8gRm9sZGVyIGluZm9cbiAgICAgICAgY29udGVudEVsLmNyZWF0ZUVsKCdsYWJlbCcsIHsgdGV4dDogJ0ZvbGRlcjonIH0pO1xuICAgICAgICBjb250ZW50RWwuY3JlYXRlRWwoJ2RpdicsIHsgdGV4dDogdGhpcy5mb2xkZXIsIGNsczogJ25ldy10YXNrLWluZm8nIH0pO1xuXG4gICAgICAgIC8vIFByaW9yaXR5IHNlbGVjdGlvblxuICAgICAgICBjb250ZW50RWwuY3JlYXRlRWwoJ2xhYmVsJywgeyB0ZXh0OiAnUHJpb3JpdHk6JyB9KTtcbiAgICAgICAgY29uc3QgcHJpb3JpdHlTZWxlY3QgPSBjb250ZW50RWwuY3JlYXRlRWwoJ3NlbGVjdCcpO1xuICAgICAgICBwcmlvcml0eVNlbGVjdC5zdHlsZS53aWR0aCA9ICcxMDAlJztcbiAgICAgICAgcHJpb3JpdHlTZWxlY3Quc3R5bGUubWFyZ2luQm90dG9tID0gJzE2cHgnO1xuICAgICAgICBbJ2hpZ2gnLCAnbWVkaXVtJywgJ2xvdyddLmZvckVhY2gocCA9PiB7XG4gICAgICAgICAgICBjb25zdCBvcHRpb24gPSBwcmlvcml0eVNlbGVjdC5jcmVhdGVFbCgnb3B0aW9uJywgeyB0ZXh0OiBwLCB2YWx1ZTogcCB9KTtcbiAgICAgICAgICAgIGlmIChwID09PSAnbWVkaXVtJykgb3B0aW9uLnNlbGVjdGVkID0gdHJ1ZTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gQnV0dG9uc1xuICAgICAgICBjb25zdCBidXR0b25Db250YWluZXIgPSBjb250ZW50RWwuY3JlYXRlRGl2KHsgY2xzOiAnbW9kYWwtYnV0dG9uLWNvbnRhaW5lcicgfSk7XG5cbiAgICAgICAgY29uc3Qgc3VibWl0QnRuID0gYnV0dG9uQ29udGFpbmVyLmNyZWF0ZUVsKCdidXR0b24nLCB7XG4gICAgICAgICAgICB0ZXh0OiAnQ3JlYXRlJyxcbiAgICAgICAgICAgIGNsczogJ21vZC1jdGEnXG4gICAgICAgIH0pO1xuICAgICAgICBzdWJtaXRCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCB0YWdOYW1lID0gdGFnSW5wdXQudmFsdWUudHJpbSgpLnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvXFxzKy9nLCAnLScpO1xuICAgICAgICAgICAgY29uc3QgdGl0bGUgPSB0aXRsZUlucHV0LnZhbHVlLnRyaW0oKTtcbiAgICAgICAgICAgIGlmICh0YWdOYW1lICYmIHRpdGxlKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5vblN1Ym1pdCh0YWdOYW1lLCB0aXRsZSwgcHJpb3JpdHlTZWxlY3QudmFsdWUpO1xuICAgICAgICAgICAgICAgIHRoaXMuY2xvc2UoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgY29uc3QgY2FuY2VsQnRuID0gYnV0dG9uQ29udGFpbmVyLmNyZWF0ZUVsKCdidXR0b24nLCB7IHRleHQ6ICdDYW5jZWwnIH0pO1xuICAgICAgICBjYW5jZWxCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB0aGlzLmNsb3NlKCkpO1xuXG4gICAgICAgIC8vIEZvY3VzIHRhZyBpbnB1dFxuICAgICAgICB0YWdJbnB1dC5mb2N1cygpO1xuICAgIH1cblxuICAgIG9uQ2xvc2UoKSB7XG4gICAgICAgIGNvbnN0IHsgY29udGVudEVsIH0gPSB0aGlzO1xuICAgICAgICBjb250ZW50RWwuZW1wdHkoKTtcbiAgICB9XG59XG5cbi8vIFNldHRpbmdzIFRhYlxuY2xhc3MgVGFza0JvYXJkU2V0dGluZ1RhYiBleHRlbmRzIFBsdWdpblNldHRpbmdUYWIge1xuICAgIHBsdWdpbjogVGFza0JvYXJkUGx1Z2luO1xuXG4gICAgY29uc3RydWN0b3IoYXBwOiBBcHAsIHBsdWdpbjogVGFza0JvYXJkUGx1Z2luKSB7XG4gICAgICAgIHN1cGVyKGFwcCwgcGx1Z2luKTtcbiAgICAgICAgdGhpcy5wbHVnaW4gPSBwbHVnaW47XG4gICAgfVxuXG4gICAgZGlzcGxheSgpOiB2b2lkIHtcbiAgICAgICAgY29uc3QgeyBjb250YWluZXJFbCB9ID0gdGhpcztcbiAgICAgICAgY29udGFpbmVyRWwuZW1wdHkoKTtcblxuICAgICAgICBjb250YWluZXJFbC5jcmVhdGVFbCgnaDInLCB7IHRleHQ6ICdUYXNrIEJvYXJkIFNldHRpbmdzJyB9KTtcblxuICAgICAgICAvLyBUYXNrIGZvbGRlcnNcbiAgICAgICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAgICAgICAuc2V0TmFtZSgnVGFzayBmb2xkZXIgbmFtZXMnKVxuICAgICAgICAgICAgLnNldERlc2MoJ05hbWVzIG9mIGZvbGRlcnMgdGhhdCBjb250YWluIHRhc2tzIChjb21tYS1zZXBhcmF0ZWQpLiBXaWxsIHNlYXJjaCBpbiBzdWJmb2xkZXJzIHJlY3Vyc2l2ZWx5LicpXG4gICAgICAgICAgICAuYWRkVGV4dCh0ZXh0ID0+IHRleHRcbiAgICAgICAgICAgICAgICAuc2V0UGxhY2Vob2xkZXIoJ3Rhc2tzLCB0b2RvLCBpc3N1ZXMnKVxuICAgICAgICAgICAgICAgIC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy50YXNrRm9sZGVycy5qb2luKCcsICcpKVxuICAgICAgICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MudGFza0ZvbGRlcnMgPSB2YWx1ZVxuICAgICAgICAgICAgICAgICAgICAgICAgLnNwbGl0KCcsJylcbiAgICAgICAgICAgICAgICAgICAgICAgIC5tYXAocyA9PiBzLnRyaW0oKSlcbiAgICAgICAgICAgICAgICAgICAgICAgIC5maWx0ZXIocyA9PiBzLmxlbmd0aCA+IDApO1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICAgICAgICB9KSk7XG5cbiAgICAgICAgLy8gU3RhdHVzIG9yZGVyXG4gICAgICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgICAgICAgLnNldE5hbWUoJ1N0YXR1cyBjb2x1bW5zJylcbiAgICAgICAgICAgIC5zZXREZXNjKCdPcmRlciBvZiBzdGF0dXMgY29sdW1ucyAoY29tbWEtc2VwYXJhdGVkKScpXG4gICAgICAgICAgICAuYWRkVGV4dCh0ZXh0ID0+IHRleHRcbiAgICAgICAgICAgICAgICAuc2V0UGxhY2Vob2xkZXIoJ3RvZG8sIGluLXByb2dyZXNzLCBkb25lLCBhcmNoaXZlJylcbiAgICAgICAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3Muc3RhdHVzT3JkZXIuam9pbignLCAnKSlcbiAgICAgICAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLnN0YXR1c09yZGVyID0gdmFsdWVcbiAgICAgICAgICAgICAgICAgICAgICAgIC5zcGxpdCgnLCcpXG4gICAgICAgICAgICAgICAgICAgICAgICAubWFwKHMgPT4gcy50cmltKCkpXG4gICAgICAgICAgICAgICAgICAgICAgICAuZmlsdGVyKHMgPT4gcy5sZW5ndGggPiAwKTtcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgICAgICAgfSkpO1xuXG4gICAgICAgIC8vIERlZmF1bHQgc3RhdHVzXG4gICAgICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgICAgICAgLnNldE5hbWUoJ0RlZmF1bHQgc3RhdHVzJylcbiAgICAgICAgICAgIC5zZXREZXNjKCdEZWZhdWx0IHN0YXR1cyBmb3IgdGFza3Mgd2l0aG91dCBmcm9udG1hdHRlcicpXG4gICAgICAgICAgICAuYWRkVGV4dCh0ZXh0ID0+IHRleHRcbiAgICAgICAgICAgICAgICAuc2V0UGxhY2Vob2xkZXIoJ3RvZG8nKVxuICAgICAgICAgICAgICAgIC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5kZWZhdWx0U3RhdHVzKVxuICAgICAgICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MuZGVmYXVsdFN0YXR1cyA9IHZhbHVlLnRyaW0oKSB8fCAndG9kbyc7XG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgICAgIH0pKTtcbiAgICB9XG59XG4iXX0=