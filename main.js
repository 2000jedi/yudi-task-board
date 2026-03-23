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
            // Read file content for title (first # heading)
            const content = await this.app.vault.read(file);
            let title = file.basename;
            // Try to find a # heading from content (skip frontmatter)
            const lines = content.split('\n');
            let inFrontmatter = false;
            let frontmatterEnded = false;
            for (const line of lines) {
                const trimmed = line.trim();
                // Track frontmatter state
                if (trimmed === '---') {
                    if (!inFrontmatter) {
                        inFrontmatter = true;
                        continue;
                    }
                    else {
                        inFrontmatter = false;
                        frontmatterEnded = true;
                        continue;
                    }
                }
                // Skip lines inside frontmatter
                if (inFrontmatter)
                    continue;
                // Look for # heading after frontmatter
                if (trimmed.startsWith('# ')) {
                    title = trimmed.substring(2).trim();
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1haW4udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSx1Q0FpQmtCO0FBeUJsQixNQUFNLGdCQUFnQixHQUFzQjtJQUN4QyxXQUFXLEVBQUUsQ0FBQyxPQUFPLENBQUM7SUFDdEIsV0FBVyxFQUFFLENBQUMsTUFBTSxFQUFFLGFBQWEsRUFBRSxNQUFNLEVBQUUsU0FBUyxDQUFDO0lBQ3ZELGFBQWEsRUFBRSxNQUFNO0lBQ3JCLE1BQU0sRUFBRSxVQUFVO0lBQ2xCLGFBQWEsRUFBRSxNQUFNO0lBQ3JCLGFBQWEsRUFBRSxLQUFLO0lBQ3BCLGNBQWMsRUFBRSxFQUFFO0NBQ3JCLENBQUM7QUFFRixNQUFNLG9CQUFvQixHQUFHLGlCQUFpQixDQUFDO0FBRS9DLG9CQUFvQjtBQUNwQixNQUFxQixlQUFnQixTQUFRLGlCQUFNO0lBRy9DLEtBQUssQ0FBQyxNQUFNO1FBQ1IsTUFBTSxJQUFJLENBQUMsWUFBWSxFQUFFLENBQUM7UUFFMUIsMkJBQTJCO1FBQzNCLElBQUksQ0FBQyxZQUFZLENBQ2Isb0JBQW9CLEVBQ3BCLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxJQUFJLGFBQWEsQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLENBQzFDLENBQUM7UUFFRixrQkFBa0I7UUFDbEIsSUFBSSxDQUFDLGFBQWEsQ0FBQyxjQUFjLEVBQUUsaUJBQWlCLEVBQUUsR0FBRyxFQUFFO1lBQ3ZELElBQUksQ0FBQyxZQUFZLEVBQUUsQ0FBQztRQUN4QixDQUFDLENBQUMsQ0FBQztRQUVILGdDQUFnQztRQUNoQyxJQUFJLENBQUMsVUFBVSxDQUFDO1lBQ1osRUFBRSxFQUFFLGlCQUFpQjtZQUNyQixJQUFJLEVBQUUsaUJBQWlCO1lBQ3ZCLFFBQVEsRUFBRSxHQUFHLEVBQUU7Z0JBQ1gsSUFBSSxDQUFDLFlBQVksRUFBRSxDQUFDO1lBQ3hCLENBQUM7U0FDSixDQUFDLENBQUM7UUFFSCxzQ0FBc0M7UUFDdEMs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Z0IsQ0FBQzthQUN6QixPQUFPLENBQUMsOENBQThDLENBQUM7YUFDdkQsT0FBTyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsSUFBSTthQUNoQixjQUFjLENBQUMsTUFBTSxDQUFDO2FBQ3RCLFFBQVEsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxhQUFhLENBQUM7YUFDNUMsUUFBUSxDQUFDLEtBQUssRUFBRSxLQUFLLEVBQUUsRUFBRTtZQUN0QixJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxhQUFhLEdBQUcsS0FBSyxDQUFDLElBQUksRUFBRSxJQUFJLE1BQU0sQ0FBQztZQUM1RCxNQUFNLElBQUksQ0FBQyxNQUFNLENBQUMsWUFBWSxFQUFFLENBQUM7UUFDckMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUNoQixDQUFDO0NBQ0oiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQge1xuICAgIEFwcCxcbiAgICBQbHVnaW4sXG4gICAgUGx1Z2luU2V0dGluZ1RhYixcbiAgICBTZXR0aW5nLFxuICAgIFRGaWxlLFxuICAgIFRGb2xkZXIsXG4gICAgSXRlbVZpZXcsXG4gICAgV29ya3NwYWNlTGVhZixcbiAgICBOb3RpY2UsXG4gICAgTWVudSxcbiAgICBUZXh0Q29tcG9uZW50LFxuICAgIERyb3Bkb3duQ29tcG9uZW50LFxuICAgIEJ1dHRvbkNvbXBvbmVudCxcbiAgICBNYXJrZG93blJlbmRlcmVyLFxuICAgIENvbXBvbmVudCxcbiAgICBNb2RhbFxufSBmcm9tICdvYnNpZGlhbic7XG5cbi8vIFRhc2sgaW50ZXJmYWNlXG5pbnRlcmZhY2UgVGFzayB7XG4gICAgaWQ6IHN0cmluZztcbiAgICBmaWxlOiBURmlsZTtcbiAgICB0aXRsZTogc3RyaW5nO1xuICAgIHN0YXR1czogc3RyaW5nO1xuICAgIHRhZzogc3RyaW5nO1xuICAgIHByaW9yaXR5OiAnaGlnaCcgfCAnbWVkaXVtJyB8ICdsb3cnO1xuICAgIGNvbnRlbnQ6IHN0cmluZztcbiAgICBmb2xkZXI6IHN0cmluZztcbn1cblxuLy8gUGx1Z2luIHNldHRpbmdzXG5pbnRlcmZhY2UgVGFza0JvYXJkU2V0dGluZ3Mge1xuICAgIHRhc2tGb2xkZXJzOiBzdHJpbmdbXTtcbiAgICBzdGF0dXNPcmRlcjogc3RyaW5nW107XG4gICAgZGVmYXVsdFN0YXR1czogc3RyaW5nO1xuICAgIHNvcnRCeTogJ3ByaW9yaXR5JyB8ICd0YWcnIHwgJ3RpdGxlJyB8ICdmb2xkZXInO1xuICAgIHNvcnREaXJlY3Rpb246ICdhc2MnIHwgJ2Rlc2MnO1xuICAgIG9yZ2FuaXplQnlUYWc6IGJvb2xlYW47XG4gICAgaGlkZGVuU3RhdHVzZXM6IHN0cmluZ1tdO1xufVxuXG5jb25zdCBERUZBVUxUX1NFVFRJTkdTOiBUYXNrQm9hcmRTZXR0aW5ncyA9IHtcbiAgICB0YXNrRm9sZGVyczogWyd0YXNrcyddLFxuICAgIHN0YXR1c09yZGVyOiBbJ3RvZG8nLCAnaW4tcHJvZ3Jlc3MnLCAnZG9uZScsICdhcmNoaXZlJ10sXG4gICAgZGVmYXVsdFN0YXR1czogJ3RvZG8nLFxuICAgIHNvcnRCeTogJ3ByaW9yaXR5JyxcbiAgICBzb3J0RGlyZWN0aW9uOiAnZGVzYycsXG4gICAgb3JnYW5pemVCeVRhZzogZmFsc2UsXG4gICAgaGlkZGVuU3RhdHVzZXM6IFtdXG59O1xuXG5jb25zdCBWSUVXX1RZUEVfVEFTS19CT0FSRCA9ICd0YXNrLWJvYXJkLXZpZXcnO1xuXG4vLyBNYWluIFBsdWdpbiBDbGFzc1xuZXhwb3J0IGRlZmF1bHQgY2xhc3MgVGFza0JvYXJkUGx1Z2luIGV4dGVuZHMgUGx1Z2luIHtcbiAgICBzZXR0aW5nczogVGFza0JvYXJkU2V0dGluZ3M7XG5cbiAgICBhc3luYyBvbmxvYWQoKSB7XG4gICAgICAgIGF3YWl0IHRoaXMubG9hZFNldHRpbmdzKCk7XG5cbiAgICAgICAgLy8gUmVnaXN0ZXIgdGhlIGN1c3RvbSB2aWV3XG4gICAgICAgIHRoaXMucmVnaXN0ZXJWaWV3KFxuICAgICAgICAgICAgVklFV19UWVBFX1RBU0tfQk9BUkQsXG4gICAgICAgICAgICAobGVhZikgPT4gbmV3IFRhc2tCb2FyZFZpZXcobGVhZiwgdGhpcylcbiAgICAgICAgKTtcblxuICAgICAgICAvLyBBZGQgcmliYm9uIGljb25cbiAgICAgICAgdGhpcy5hZGRSaWJib25JY29uKCdsYXlvdXQtYm9hcmQnLCAnT3BlbiBUYXNrIEJvYXJkJywgKCkgPT4ge1xuICAgICAgICAgICAgdGhpcy5hY3RpdmF0ZVZpZXcoKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gQWRkIGNvbW1hbmQgLSBPcGVuIFRhc2sgQm9hcmRcbiAgICAgICAgdGhpcy5hZGRDb21tYW5kKHtcbiAgICAgICAgICAgIGlkOiAnb3Blbi10YXNrLWJvYXJkJyxcbiAgICAgICAgICAgIG5hbWU6ICdPcGVuIFRhc2sgQm9hcmQnLFxuICAgICAgICAgICAgY2FsbGJhY2s6ICgpID0+IHtcbiAgICAgICAgICAgICAgICB0aGlzLmFjdGl2YXRlVmlldygpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICAvLyBBZGQgY29tbWFuZCAtIE9yZ2FuaXplIHRhc2tzIGJ5IHRhZ1xuICAgICAgICB0aGlzLmFkZENvbW1hbmQoe1xuICAgICAgICAgICAgaWQ6ICdvcmdhbml6ZS10YXNrcy1ieS10YWcnLFxuICAgICAgICAgICAgbmFtZTogJ09yZ2FuaXplIHRhc2tzIGJ5IHRhZycsXG4gICAgICAgICAgICBjYWxsYmFjazogYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMub3JnYW5pemVUYXNrc0J5VGFnKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIEFkZCBjb21tYW5kIC0gT3JnYW5pemUgdGFza3MgaW4gY3VycmVudCBmb2xkZXJcbiAgICAgICAgdGhpcy5hZGRDb21tYW5kKHtcbiAgICAgICAgICAgIGlkOiAnb3JnYW5pemUtdGFza3MtaW4tY3VycmVudC1mb2xkZXInLFxuICAgICAgICAgICAgbmFtZTogJ09yZ2FuaXplIHRhc2tzIGluIGN1cnJlbnQgZm9sZGVyIGJ5IHRhZycsXG4gICAgICAgICAgICBjaGVja0NhbGxiYWNrOiAoY2hlY2tpbmc6IGJvb2xlYW4pID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCBmaWxlID0gdGhpcy5hcHAud29ya3NwYWNlLmdldEFjdGl2ZUZpbGUoKTtcbiAgICAgICAgICAgICAgICBpZiAoZmlsZSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWNoZWNraW5nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBmb2xkZXIgPSBmaWxlLnBhcmVudDtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChmb2xkZXIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLm9yZ2FuaXplVGFza3NJbkZvbGRlcihmb2xkZXIpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIEFkZCBzZXR0aW5ncyB0YWJcbiAgICAgICAgdGhpcy5hZGRTZXR0aW5nVGFiKG5ldyBUYXNrQm9hcmRTZXR0aW5nVGFiKHRoaXMuYXBwLCB0aGlzKSk7XG5cbiAgICAgICAgLy8gUmVmcmVzaCB2aWV3IHdoZW4gZmlsZXMgY2hhbmdlXG4gICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudChcbiAgICAgICAgICAgIHRoaXMuYXBwLnZhdWx0Lm9uKCdjcmVhdGUnLCAoKSA9PiB0aGlzLnJlZnJlc2hWaWV3KCkpXG4gICAgICAgICk7XG4gICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudChcbiAgICAgICAgICAgIHRoaXMuYXBwLnZhdWx0Lm9uKCdkZWxldGUnLCAoKSA9PiB0aGlzLnJlZnJlc2hWaWV3KCkpXG4gICAgICAgICk7XG4gICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudChcbiAgICAgICAgICAgIHRoaXMuYXBwLnZhdWx0Lm9uKCdyZW5hbWUnLCAoKSA9PiB0aGlzLnJlZnJlc2hWaWV3KCkpXG4gICAgICAgICk7XG4gICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudChcbiAgICAgICAgICAgIHRoaXMuYXBwLm1ldGFkYXRhQ2FjaGUub24oJ2NoYW5nZWQnLCAoKSA9PiB0aGlzLnJlZnJlc2hWaWV3KCkpXG4gICAgICAgICk7XG4gICAgfVxuXG4gICAgb251bmxvYWQoKSB7XG4gICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5kZXRhY2hMZWF2ZXNPZlR5cGUoVklFV19UWVBFX1RBU0tfQk9BUkQpO1xuICAgIH1cblxuICAgIGFzeW5jIGxvYWRTZXR0aW5ncygpIHtcbiAgICAgICAgdGhpcy5zZXR0aW5ncyA9IE9iamVjdC5hc3NpZ24oe30sIERFRkFVTFRfU0VUVElOR1MsIGF3YWl0IHRoaXMubG9hZERhdGEoKSk7XG4gICAgfVxuXG4gICAgYXN5bmMgc2F2ZVNldHRpbmdzKCkge1xuICAgICAgICBhd2FpdCB0aGlzLnNhdmVEYXRhKHRoaXMuc2V0dGluZ3MpO1xuICAgICAgICB0aGlzLnJlZnJlc2hWaWV3KCk7XG4gICAgfVxuXG4gICAgYXN5bmMgYWN0aXZhdGVWaWV3KCkge1xuICAgICAgICBjb25zdCB7IHdvcmtzcGFjZSB9ID0gdGhpcy5hcHA7XG5cbiAgICAgICAgbGV0IGxlYWY6IFdvcmtzcGFjZUxlYWYgfCBudWxsID0gbnVsbDtcbiAgICAgICAgY29uc3QgbGVhdmVzID0gd29ya3NwYWNlLmdldExlYXZlc09mVHlwZShWSUVXX1RZUEVfVEFTS19CT0FSRCk7XG5cbiAgICAgICAgaWYgKGxlYXZlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBsZWFmID0gbGVhdmVzWzBdO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gQ3JlYXRlIGluIG1haW4gdmlldyBhcmVhIGluc3RlYWQgb2Ygc2lkZWJhclxuICAgICAgICAgICAgbGVhZiA9IHdvcmtzcGFjZS5nZXRMZWFmKCd0YWInKTtcbiAgICAgICAgICAgIGF3YWl0IGxlYWYuc2V0Vmlld1N0YXRlKHsgdHlwZTogVklFV19UWVBFX1RBU0tfQk9BUkQsIGFjdGl2ZTogdHJ1ZSB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHdvcmtzcGFjZS5yZXZlYWxMZWFmKGxlYWYpO1xuICAgIH1cblxuICAgIHJlZnJlc2hWaWV3KCkge1xuICAgICAgICBjb25zdCBsZWF2ZXMgPSB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0TGVhdmVzT2ZUeXBlKFZJRVdfVFlQRV9UQVNLX0JPQVJEKTtcbiAgICAgICAgZm9yIChjb25zdCBsZWFmIG9mIGxlYXZlcykge1xuICAgICAgICAgICAgY29uc3QgdmlldyA9IGxlYWYudmlldyBhcyBUYXNrQm9hcmRWaWV3O1xuICAgICAgICAgICAgdmlldy5yZWZyZXNoKCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBSZWN1cnNpdmVseSBjb2xsZWN0IGFsbCBtYXJrZG93biBmaWxlcyBmcm9tIGEgZm9sZGVyIGFuZCBpdHMgc3ViZm9sZGVyc1xuICAgIHByaXZhdGUgY29sbGVjdE1hcmtkb3duRmlsZXMoZm9sZGVyOiBURm9sZGVyKTogVEZpbGVbXSB7XG4gICAgICAgIGNvbnN0IGZpbGVzOiBURmlsZVtdID0gW107XG4gICAgICAgIFxuICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIGZvbGRlci5jaGlsZHJlbikge1xuICAgICAgICAgICAgaWYgKGNoaWxkIGluc3RhbmNlb2YgVEZpbGUgJiYgY2hpbGQuZXh0ZW5zaW9uID09PSAnbWQnKSB7XG4gICAgICAgICAgICAgICAgZmlsZXMucHVzaChjaGlsZCk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGNoaWxkIGluc3RhbmNlb2YgVEZvbGRlcikge1xuICAgICAgICAgICAgICAgIC8vIFJlY3Vyc2l2ZWx5IGdldCBmaWxlcyBmcm9tIHN1YmZvbGRlcnNcbiAgICAgICAgICAgICAgICBmaWxlcy5wdXNoKC4uLnRoaXMuY29sbGVjdE1hcmtkb3duRmlsZXMoY2hpbGQpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIGZpbGVzO1xuICAgIH1cblxuICAgIC8vIFNjYW4gYWxsIHRhc2sgZm9sZGVycyBhbmQgcmV0dXJuIHRhc2tzIChpbmNsdWRpbmcgc3ViZm9sZGVycylcbiAgICBhc3luYyBzY2FuVGFza3MoKTogUHJvbWlzZTxUYXNrW10+IHtcbiAgICAgICAgY29uc3QgdGFza3M6IFRhc2tbXSA9IFtdO1xuICAgICAgICBjb25zdCB2YXVsdCA9IHRoaXMuYXBwLnZhdWx0O1xuXG4gICAgICAgIC8vIEdldCBhbGwgZm9sZGVycyBpbiB2YXVsdFxuICAgICAgICBjb25zdCBhbGxGb2xkZXJzID0gdmF1bHQuZ2V0QWxsTG9hZGVkRmlsZXMoKVxuICAgICAgICAgICAgLmZpbHRlcihmID0+IGYgaW5zdGFuY2VvZiBURm9sZGVyKSBhcyBURm9sZGVyW107XG5cbiAgICAgICAgLy8gRmluZCB0YXNrIGZvbGRlcnMgKGV4YWN0IG1hdGNoZXMgb3IgZm9sZGVycyBlbmRpbmcgd2l0aCAvdGFza3MsIGV0Yy4pXG4gICAgICAgIGNvbnN0IHRhc2tGb2xkZXJzOiBURm9sZGVyW10gPSBbXTtcbiAgICAgICAgZm9yIChjb25zdCBmb2xkZXIgb2YgYWxsRm9sZGVycykge1xuICAgICAgICAgICAgaWYgKHRoaXMuc2V0dGluZ3MudGFza0ZvbGRlcnMuc29tZSh0ZiA9PiBcbiAgICAgICAgICAgICAgICBmb2xkZXIucGF0aCA9PT0gdGYgfHwgXG4gICAgICAgICAgICAgICAgZm9sZGVyLnBhdGguZW5kc1dpdGgoJy8nICsgdGYpIHx8XG4gICAgICAgICAgICAgICAgZm9sZGVyLm5hbWUgPT09IHRmXG4gICAgICAgICAgICApKSB7XG4gICAgICAgICAgICAgICAgdGFza0ZvbGRlcnMucHVzaChmb2xkZXIpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gU2NhbiBlYWNoIHRhc2sgZm9sZGVyIHJlY3Vyc2l2ZWx5XG4gICAgICAgIGZvciAoY29uc3QgZm9sZGVyIG9mIHRhc2tGb2xkZXJzKSB7XG4gICAgICAgICAgICAvLyBSZWN1cnNpdmVseSBjb2xsZWN0IGFsbCBtYXJrZG93biBmaWxlcyBpbmNsdWRpbmcgc3ViZm9sZGVyc1xuICAgICAgICAgICAgY29uc3QgZmlsZXMgPSB0aGlzLmNvbGxlY3RNYXJrZG93bkZpbGVzKGZvbGRlcik7XG5cbiAgICAgICAgICAgIGZvciAoY29uc3QgZmlsZSBvZiBmaWxlcykge1xuICAgICAgICAgICAgICAgIGNvbnN0IHRhc2sgPSBhd2FpdCB0aGlzLnBhcnNlVGFza0ZpbGUoZmlsZSwgZm9sZGVyKTtcbiAgICAgICAgICAgICAgICBpZiAodGFzaykge1xuICAgICAgICAgICAgICAgICAgICB0YXNrcy5wdXNoKHRhc2spO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0YXNrcztcbiAgICB9XG5cbiAgICAvLyBQYXJzZSBhIHRhc2sgZmlsZSBhbmQgZXh0cmFjdCBtZXRhZGF0YVxuICAgIGFzeW5jIHBhcnNlVGFza0ZpbGUoZmlsZTogVEZpbGUsIGZvbGRlcjogVEZvbGRlcik6IFByb21pc2U8VGFzayB8IG51bGw+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGNhY2hlID0gdGhpcy5hcHAubWV0YWRhdGFDYWNoZS5nZXRGaWxlQ2FjaGUoZmlsZSk7XG4gICAgICAgICAgICBjb25zdCBmcm9udG1hdHRlciA9IGNhY2hlPy5mcm9udG1hdHRlcjtcblxuICAgICAgICAgICAgLy8gUmVhZCBmaWxlIGNvbnRlbnQgZm9yIHRpdGxlIChmaXJzdCAjIGhlYWRpbmcpXG4gICAgICAgICAgICBjb25zdCBjb250ZW50ID0gYXdhaXQgdGhpcy5hcHAudmF1bHQucmVhZChmaWxlKTtcbiAgICAgICAgICAgIGxldCB0aXRsZSA9IGZpbGUuYmFzZW5hbWU7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIFRyeSB0byBmaW5kIGEgIyBoZWFkaW5nIGZyb20gY29udGVudCAoc2tpcCBmcm9udG1hdHRlcilcbiAgICAgICAgICAgIGNvbnN0IGxpbmVzID0gY29udGVudC5zcGxpdCgnXFxuJyk7XG4gICAgICAgICAgICBsZXQgaW5Gcm9udG1hdHRlciA9IGZhbHNlO1xuICAgICAgICAgICAgbGV0IGZyb250bWF0dGVyRW5kZWQgPSBmYWxzZTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgdHJpbW1lZCA9IGxpbmUudHJpbSgpO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIC8vIFRyYWNrIGZyb250bWF0dGVyIHN0YXRlXG4gICAgICAgICAgICAgICAgaWYgKHRyaW1tZWQgPT09ICctLS0nKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghaW5Gcm9udG1hdHRlcikge1xuICAgICAgICAgICAgICAgICAgICAgICAgaW5Gcm9udG1hdHRlciA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGluRnJvbnRtYXR0ZXIgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGZyb250bWF0dGVyRW5kZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgLy8gU2tpcCBsaW5lcyBpbnNpZGUgZnJvbnRtYXR0ZXJcbiAgICAgICAgICAgICAgICBpZiAoaW5Gcm9udG1hdHRlcikgY29udGludWU7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgLy8gTG9vayBmb3IgIyBoZWFkaW5nIGFmdGVyIGZyb250bWF0dGVyXG4gICAgICAgICAgICAgICAgaWYgKHRyaW1tZWQuc3RhcnRzV2l0aCgnIyAnKSkge1xuICAgICAgICAgICAgICAgICAgICB0aXRsZSA9IHRyaW1tZWQuc3Vic3RyaW5nKDIpLnRyaW0oKTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBHZXQgcGFyZW50IGZvbGRlciBuYW1lIGFzIGNhdGVnb3J5XG4gICAgICAgICAgICBjb25zdCBmb2xkZXJQYXJ0cyA9IGZvbGRlci5wYXRoLnNwbGl0KCcvJyk7XG4gICAgICAgICAgICBjb25zdCBwYXJlbnRGb2xkZXIgPSBmb2xkZXJQYXJ0cy5sZW5ndGggPiAxID8gZm9sZGVyUGFydHNbZm9sZGVyUGFydHMubGVuZ3RoIC0gMl0gOiAnUm9vdCc7XG5cbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgaWQ6IGZpbGUucGF0aCxcbiAgICAgICAgICAgICAgICBmaWxlOiBmaWxlLFxuICAgICAgICAgICAgICAgIHRpdGxlOiB0aXRsZSxcbiAgICAgICAgICAgICAgICBzdGF0dXM6IGZyb250bWF0dGVyPy5zdGF0dXMgfHwgdGhpcy5zZXR0aW5ncy5kZWZhdWx0U3RhdHVzLFxuICAgICAgICAgICAgICAgIHRhZzogZnJvbnRtYXR0ZXI/LnRhZyB8fCAndW50YWdnZWQnLFxuICAgICAgICAgICAgICAgIHByaW9yaXR5OiAoZnJvbnRtYXR0ZXI/LnByaW9yaXR5IHx8ICdtZWRpdW0nKSBhcyAnaGlnaCcgfCAnbWVkaXVtJyB8ICdsb3cnLFxuICAgICAgICAgICAgICAgIGNvbnRlbnQ6IGNvbnRlbnQsXG4gICAgICAgICAgICAgICAgZm9sZGVyOiBwYXJlbnRGb2xkZXJcbiAgICAgICAgICAgIH07XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKCdFcnJvciBwYXJzaW5nIHRhc2sgZmlsZTonLCBmaWxlLnBhdGgsIGVycm9yKTtcbiAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gVXBkYXRlIHRhc2sgc3RhdHVzXG4gICAgYXN5bmMgdXBkYXRlVGFza1N0YXR1cyh0YXNrOiBUYXNrLCBuZXdTdGF0dXM6IHN0cmluZykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgY2FjaGUgPSB0aGlzLmFwcC5tZXRhZGF0YUNhY2hlLmdldEZpbGVDYWNoZSh0YXNrLmZpbGUpO1xuICAgICAgICAgICAgY29uc3QgZnJvbnRtYXR0ZXIgPSBjYWNoZT8uZnJvbnRtYXR0ZXI7XG5cbiAgICAgICAgICAgIGlmIChmcm9udG1hdHRlcikge1xuICAgICAgICAgICAgICAgIC8vIFVwZGF0ZSBmcm9udG1hdHRlclxuICAgICAgICAgICAgICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCB0aGlzLmFwcC52YXVsdC5yZWFkKHRhc2suZmlsZSk7XG4gICAgICAgICAgICAgICAgY29uc3QgZnJvbnRtYXR0ZXJSZWdleCA9IC9eLS0tXFxuKFtcXHNcXFNdKj8pXFxuLS0tLztcbiAgICAgICAgICAgICAgICBjb25zdCBtYXRjaCA9IGNvbnRlbnQubWF0Y2goZnJvbnRtYXR0ZXJSZWdleCk7XG5cbiAgICAgICAgICAgICAgICBpZiAobWF0Y2gpIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IG5ld0Zyb250bWF0dGVyID0gbWF0Y2hbMV07XG4gICAgICAgICAgICAgICAgICAgIC8vIFJlcGxhY2Ugc3RhdHVzIGxpbmVcbiAgICAgICAgICAgICAgICAgICAgbmV3RnJvbnRtYXR0ZXIgPSBuZXdGcm9udG1hdHRlci5yZXBsYWNlKFxuICAgICAgICAgICAgICAgICAgICAgICAgL3N0YXR1czpcXHMqXFx3Ky8sXG4gICAgICAgICAgICAgICAgICAgICAgICBgc3RhdHVzOiAke25ld1N0YXR1c31gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIC8vIElmIHN0YXR1cyBkb2Vzbid0IGV4aXN0LCBhZGQgaXRcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFuZXdGcm9udG1hdHRlci5pbmNsdWRlcygnc3RhdHVzOicpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBuZXdGcm9udG1hdHRlciA9IGBzdGF0dXM6ICR7bmV3U3RhdHVzfVxcbiR7bmV3RnJvbnRtYXR0ZXJ9YDtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG5ld0NvbnRlbnQgPSBjb250ZW50LnJlcGxhY2UoZnJvbnRtYXR0ZXJSZWdleCwgYC0tLVxcbiR7bmV3RnJvbnRtYXR0ZXJ9XFxuLS0tYCk7XG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYXBwLnZhdWx0Lm1vZGlmeSh0YXNrLmZpbGUsIG5ld0NvbnRlbnQpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgLy8gQWRkIGZyb250bWF0dGVyIGlmIGl0IGRvZXNuJ3QgZXhpc3RcbiAgICAgICAgICAgICAgICBjb25zdCBuZXdGcm9udG1hdHRlciA9IGAtLS1cXG5zdGF0dXM6ICR7bmV3U3RhdHVzfVxcbnRhZzogJHt0YXNrLnRhZ31cXG5wcmlvcml0eTogJHt0YXNrLnByaW9yaXR5fVxcbi0tLVxcblxcbmA7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hcHAudmF1bHQubW9kaWZ5KHRhc2suZmlsZSwgbmV3RnJvbnRtYXR0ZXIgKyB0YXNrLmNvbnRlbnQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0YXNrLnN0YXR1cyA9IG5ld1N0YXR1cztcbiAgICAgICAgICAgIG5ldyBOb3RpY2UoYFRhc2sgbW92ZWQgdG8gJHtuZXdTdGF0dXN9YCk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKCdFcnJvciB1cGRhdGluZyB0YXNrIHN0YXR1czonLCBlcnJvcik7XG4gICAgICAgICAgICBuZXcgTm90aWNlKCdGYWlsZWQgdG8gdXBkYXRlIHRhc2sgc3RhdHVzJyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBVcGRhdGUgdGFzayBwcmlvcml0eVxuICAgIGFzeW5jIHVwZGF0ZVRhc2tQcmlvcml0eSh0YXNrOiBUYXNrLCBuZXdQcmlvcml0eTogc3RyaW5nKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBjb250ZW50ID0gYXdhaXQgdGhpcy5hcHAudmF1bHQucmVhZCh0YXNrLmZpbGUpO1xuICAgICAgICAgICAgY29uc3QgZnJvbnRtYXR0ZXJSZWdleCA9IC9eLS0tXFxuKFtcXHNcXFNdKj8pXFxuLS0tLztcbiAgICAgICAgICAgIGNvbnN0IG1hdGNoID0gY29udGVudC5tYXRjaChmcm9udG1hdHRlclJlZ2V4KTtcblxuICAgICAgICAgICAgaWYgKG1hdGNoKSB7XG4gICAgICAgICAgICAgICAgbGV0IG5ld0Zyb250bWF0dGVyID0gbWF0Y2hbMV07XG4gICAgICAgICAgICAgICAgbmV3RnJvbnRtYXR0ZXIgPSBuZXdGcm9udG1hdHRlci5yZXBsYWNlKFxuICAgICAgICAgICAgICAgICAgICAvcHJpb3JpdHk6XFxzKlxcdysvLFxuICAgICAgICAgICAgICAgICAgICBgcHJpb3JpdHk6ICR7bmV3UHJpb3JpdHl9YFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgaWYgKCFuZXdGcm9udG1hdHRlci5pbmNsdWRlcygncHJpb3JpdHk6JykpIHtcbiAgICAgICAgICAgICAgICAgICAgbmV3RnJvbnRtYXR0ZXIgPSBuZXdGcm9udG1hdHRlci5yZXBsYWNlKFxuICAgICAgICAgICAgICAgICAgICAgICAgLyhzdGF0dXM6W15cXG5dKikvLFxuICAgICAgICAgICAgICAgICAgICAgICAgYCQxXFxucHJpb3JpdHk6ICR7bmV3UHJpb3JpdHl9YFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0IG5ld0NvbnRlbnQgPSBjb250ZW50LnJlcGxhY2UoZnJvbnRtYXR0ZXJSZWdleCwgYC0tLVxcbiR7bmV3RnJvbnRtYXR0ZXJ9XFxuLS0tYCk7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hcHAudmF1bHQubW9kaWZ5KHRhc2suZmlsZSwgbmV3Q29udGVudCk7XG4gICAgICAgICAgICAgICAgdGFzay5wcmlvcml0eSA9IG5ld1ByaW9yaXR5IGFzICdoaWdoJyB8ICdtZWRpdW0nIHwgJ2xvdyc7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKCdFcnJvciB1cGRhdGluZyB0YXNrIHByaW9yaXR5OicsIGVycm9yKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIFVwZGF0ZSB0YXNrIHRhZ1xuICAgIGFzeW5jIHVwZGF0ZVRhc2sodGFzazogVGFzaywgbmV3VGFnOiBzdHJpbmcpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCB0aGlzLmFwcC52YXVsdC5yZWFkKHRhc2suZmlsZSk7XG4gICAgICAgICAgICBjb25zdCBmcm9udG1hdHRlclJlZ2V4ID0gL14tLS1cXG4oW1xcc1xcU10qPylcXG4tLS0vO1xuICAgICAgICAgICAgY29uc3QgbWF0Y2ggPSBjb250ZW50Lm1hdGNoKGZyb250bWF0dGVyUmVnZXgpO1xuXG4gICAgICAgICAgICBpZiAobWF0Y2gpIHtcbiAgICAgICAgICAgICAgICBsZXQgbmV3RnJvbnRtYXR0ZXIgPSBtYXRjaFsxXTtcbiAgICAgICAgICAgICAgICBuZXdGcm9udG1hdHRlciA9IG5ld0Zyb250bWF0dGVyLnJlcGxhY2UoXG4gICAgICAgICAgICAgICAgICAgIC90YWc6XFxzKlxcUysvLFxuICAgICAgICAgICAgICAgICAgICBgdGFnOiAke25ld1RhZ31gXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICBpZiAoIW5ld0Zyb250bWF0dGVyLmluY2x1ZGVzKCd0YWc6JykpIHtcbiAgICAgICAgICAgICAgICAgICAgbmV3RnJvbnRtYXR0ZXIgPSBuZXdGcm9udG1hdHRlci5yZXBsYWNlKFxuICAgICAgICAgICAgICAgICAgICAgICAgLyhzdGF0dXM6W15cXG5dKikvLFxuICAgICAgICAgICAgICAgICAgICAgICAgYCQxXFxudGFnOiAke25ld1RhZ31gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29uc3QgbmV3Q29udGVudCA9IGNvbnRlbnQucmVwbGFjZShmcm9udG1hdHRlclJlZ2V4LCBgLS0tXFxuJHtuZXdGcm9udG1hdHRlcn1cXG4tLS1gKTtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5tb2RpZnkodGFzay5maWxlLCBuZXdDb250ZW50KTtcbiAgICAgICAgICAgICAgICB0YXNrLnRhZyA9IG5ld1RhZztcbiAgICAgICAgICAgICAgICBuZXcgTm90aWNlKGBUYXNrIHRhZyBjaGFuZ2VkIHRvICR7bmV3VGFnfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgY29uc29sZS5lcnJvcignRXJyb3IgdXBkYXRpbmcgdGFzayB0YWc6JywgZXJyb3IpO1xuICAgICAgICAgICAgbmV3IE5vdGljZSgnRmFpbGVkIHRvIHVwZGF0ZSB0YXNrIHRhZycpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gTW92ZSB0YXNrIHRvIGRpZmZlcmVudCBmb2xkZXJcbiAgICBhc3luYyBtb3ZlVGFza1RvRm9sZGVyKHRhc2s6IFRhc2ssIHRhcmdldEZvbGRlcjogVEZvbGRlcikge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgbmV3UGF0aCA9IGAke3RhcmdldEZvbGRlci5wYXRofS8ke3Rhc2suZmlsZS5uYW1lfWA7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5yZW5hbWUodGFzay5maWxlLCBuZXdQYXRoKTtcbiAgICAgICAgICAgIG5ldyBOb3RpY2UoYFRhc2sgbW92ZWQgdG8gJHt0YXJnZXRGb2xkZXIubmFtZX1gKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIG1vdmluZyB0YXNrOicsIGVycm9yKTtcbiAgICAgICAgICAgIG5ldyBOb3RpY2UoJ0ZhaWxlZCB0byBtb3ZlIHRhc2snKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIENyZWF0ZSBhIG5ldyB0YXNrXG4gICAgYXN5bmMgY3JlYXRlTmV3VGFzayh0aXRsZTogc3RyaW5nLCBmb2xkZXJOYW1lOiBzdHJpbmcsIHRhZzogc3RyaW5nLCBwcmlvcml0eTogc3RyaW5nID0gJ21lZGl1bScpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIC8vIEZpbmQgdGhlIGJhc2UgdGFza3MgZm9sZGVyXG4gICAgICAgICAgICBjb25zdCB2YXVsdCA9IHRoaXMuYXBwLnZhdWx0O1xuICAgICAgICAgICAgY29uc3QgYWxsRm9sZGVycyA9IHZhdWx0LmdldEFsbExvYWRlZEZpbGVzKClcbiAgICAgICAgICAgICAgICAuZmlsdGVyKGYgPT4gZiBpbnN0YW5jZW9mIFRGb2xkZXIpIGFzIFRGb2xkZXJbXTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHRhcmdldEZvbGRlcjogVEZvbGRlciB8IG51bGwgPSBudWxsO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICAvLyBGaW5kIHRoZSB0YXNrcyBmb2xkZXIgdGhhdCBjb250YWlucyB0aGlzIGZvbGRlclxuICAgICAgICAgICAgZm9yIChjb25zdCBmb2xkZXIgb2YgYWxsRm9sZGVycykge1xuICAgICAgICAgICAgICAgIGlmIChmb2xkZXIubmFtZSA9PT0gZm9sZGVyTmFtZSB8fCBmb2xkZXIucGF0aC5pbmNsdWRlcyhgLyR7Zm9sZGVyTmFtZX0vYCkgfHwgZm9sZGVyLnBhdGguZW5kc1dpdGgoYC8ke2ZvbGRlck5hbWV9YCkpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gQ2hlY2sgaWYgdGhpcyBpcyBhIHRhc2sgZm9sZGVyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGlzVGFza0ZvbGRlciA9IHRoaXMuc2V0dGluZ3MudGFza0ZvbGRlcnMuc29tZSh0ZiA9PiBcbiAgICAgICAgICAgICAgICAgICAgICAgIGZvbGRlci5wYXRoID09PSB0ZiB8fCBcbiAgICAgICAgICAgICAgICAgICAgICAgIGZvbGRlci5wYXRoLmVuZHNXaXRoKCcvJyArIHRmKSB8fFxuICAgICAgICAgICAgICAgICAgICAgICAgZm9sZGVyLm5hbWUgPT09IHRmXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChpc1Rhc2tGb2xkZXIgfHwgZm9sZGVyLnBhdGguaW5jbHVkZXMoJy90YXNrcy8nKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFyZ2V0Rm9sZGVyID0gZm9sZGVyO1xuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIEZhbGxiYWNrOiBmaW5kIGFueSB0YXNrcyBmb2xkZXJcbiAgICAgICAgICAgIGlmICghdGFyZ2V0Rm9sZGVyKSB7XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBmb2xkZXIgb2YgYWxsRm9sZGVycykge1xuICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5zZXR0aW5ncy50YXNrRm9sZGVycy5zb21lKHRmID0+IFxuICAgICAgICAgICAgICAgICAgICAgICAgZm9sZGVyLm5hbWUgPT09IHRmIHx8IGZvbGRlci5wYXRoLmVuZHNXaXRoKCcvJyArIHRmKVxuICAgICAgICAgICAgICAgICAgICApKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0YXJnZXRGb2xkZXIgPSBmb2xkZXI7XG4gICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCF0YXJnZXRGb2xkZXIpIHtcbiAgICAgICAgICAgICAgICBuZXcgTm90aWNlKCdDb3VsZCBub3QgZmluZCB0YXNrcyBmb2xkZXInKTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIENyZWF0ZSBmb2xkZXIgZm9yIHRhZyBpZiBpdCBkb2Vzbid0IGV4aXN0XG4gICAgICAgICAgICBjb25zdCB0YWdGb2xkZXJQYXRoID0gYCR7dGFyZ2V0Rm9sZGVyLnBhdGh9LyR7dGFnfWA7XG4gICAgICAgICAgICBsZXQgdGFnRm9sZGVyID0gdmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHRhZ0ZvbGRlclBhdGgpO1xuICAgICAgICAgICAgaWYgKCF0YWdGb2xkZXIpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB2YXVsdC5jcmVhdGVGb2xkZXIodGFnRm9sZGVyUGF0aCk7XG4gICAgICAgICAgICAgICAgdGFnRm9sZGVyID0gdmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHRhZ0ZvbGRlclBhdGgpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoISh0YWdGb2xkZXIgaW5zdGFuY2VvZiBURm9sZGVyKSkge1xuICAgICAgICAgICAgICAgIG5ldyBOb3RpY2UoJ0Vycm9yIGNyZWF0aW5nIHRhZyBmb2xkZXInKTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIEdlbmVyYXRlIGZpbGVuYW1lIGZyb20gdGl0bGVcbiAgICAgICAgICAgIGNvbnN0IGZpbGVuYW1lID0gdGl0bGUudG9Mb3dlckNhc2UoKVxuICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9bXmEtejAtOVxccy1dL2csICcnKVxuICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9cXHMrL2csICctJylcbiAgICAgICAgICAgICAgICAuc3Vic3RyaW5nKDAsIDUwKSB8fCAnbmV3LXRhc2snO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25zdCBmaWxlUGF0aCA9IGAke3RhZ0ZvbGRlclBhdGh9LyR7ZmlsZW5hbWV9Lm1kYDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy8gQ2hlY2sgaWYgZmlsZSBleGlzdHMgYW5kIGFwcGVuZCBudW1iZXIgaWYgbmVlZGVkXG4gICAgICAgICAgICBsZXQgZmluYWxQYXRoID0gZmlsZVBhdGg7XG4gICAgICAgICAgICBsZXQgY291bnRlciA9IDE7XG4gICAgICAgICAgICB3aGlsZSAodmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKGZpbmFsUGF0aCkpIHtcbiAgICAgICAgICAgICAgICBmaW5hbFBhdGggPSBgJHt0YWdGb2xkZXJQYXRofS8ke2ZpbGVuYW1lfS0ke2NvdW50ZXJ9Lm1kYDtcbiAgICAgICAgICAgICAgICBjb3VudGVyKys7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIENyZWF0ZSB0YXNrIGNvbnRlbnRcbiAgICAgICAgICAgIGNvbnN0IGNvbnRlbnQgPSBgLS0tXG5zdGF0dXM6IHRvZG9cbnRhZzogJHt0YWd9XG5wcmlvcml0eTogJHtwcmlvcml0eX1cbi0tLVxuXG4jICR7dGl0bGV9XG5cbmA7XG5cbiAgICAgICAgICAgIGF3YWl0IHZhdWx0LmNyZWF0ZShmaW5hbFBhdGgsIGNvbnRlbnQpO1xuICAgICAgICAgICAgbmV3IE5vdGljZShgVGFzayBjcmVhdGVkOiAke3RpdGxlfWApO1xuICAgICAgICAgICAgdGhpcy5yZWZyZXNoVmlldygpO1xuXG4gICAgICAgICAgICAvLyBPcGVuIHRoZSBuZXcgZmlsZVxuICAgICAgICAgICAgY29uc3QgbmV3RmlsZSA9IHZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChmaW5hbFBhdGgpO1xuICAgICAgICAgICAgaWYgKG5ld0ZpbGUgaW5zdGFuY2VvZiBURmlsZSkge1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5vcGVuTGlua1RleHQobmV3RmlsZS5wYXRoLCAnJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKCdFcnJvciBjcmVhdGluZyB0YXNrOicsIGVycm9yKTtcbiAgICAgICAgICAgIG5ldyBOb3RpY2UoJ0ZhaWxlZCB0byBjcmVhdGUgdGFzaycpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gT3JnYW5pemUgYWxsIHRhc2tzIGJ5IHRhZyAtIG1vdmVzIGZpbGVzIGludG8gc3ViZm9sZGVycyBuYW1lZCBhZnRlciB0aGVpciB0YWdzXG4gICAgYXN5bmMgb3JnYW5pemVUYXNrc0J5VGFnKCkge1xuICAgICAgICBjb25zdCB0YXNrcyA9IGF3YWl0IHRoaXMuc2NhblRhc2tzKCk7XG4gICAgICAgIGNvbnN0IHRhc2tzQnlUYWcgPSBuZXcgTWFwPHN0cmluZywgVGFza1tdPigpO1xuXG4gICAgICAgIC8vIEdyb3VwIHRhc2tzIGJ5IHRhZ1xuICAgICAgICBmb3IgKGNvbnN0IHRhc2sgb2YgdGFza3MpIHtcbiAgICAgICAgICAgIGNvbnN0IHRhZyA9IHRhc2sudGFnIHx8ICd1bnRhZ2dlZCc7XG4gICAgICAgICAgICBpZiAoIXRhc2tzQnlUYWcuaGFzKHRhZykpIHtcbiAgICAgICAgICAgICAgICB0YXNrc0J5VGFnLnNldCh0YWcsIFtdKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRhc2tzQnlUYWcuZ2V0KHRhZykhLnB1c2godGFzayk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbW92ZWRDb3VudCA9IDA7XG4gICAgICAgIGNvbnN0IHZhdWx0ID0gdGhpcy5hcHAudmF1bHQ7XG5cbiAgICAgICAgLy8gUHJvY2VzcyBlYWNoIHRhZyBncm91cFxuICAgICAgICBmb3IgKGNvbnN0IFt0YWcsIHRhZ1Rhc2tzXSBvZiB0YXNrc0J5VGFnKSB7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IHRhc2sgb2YgdGFnVGFza3MpIHtcbiAgICAgICAgICAgICAgICAvLyBTa2lwIGlmIGFscmVhZHkgaW4gY29ycmVjdCBmb2xkZXJcbiAgICAgICAgICAgICAgICBjb25zdCBjdXJyZW50Rm9sZGVyID0gdGFzay5maWxlLnBhcmVudD8ubmFtZTtcbiAgICAgICAgICAgICAgICBpZiAoY3VycmVudEZvbGRlciA9PT0gdGFnKSBjb250aW51ZTtcblxuICAgICAgICAgICAgICAgIC8vIERldGVybWluZSBkZXN0aW5hdGlvbiBmb2xkZXJcbiAgICAgICAgICAgICAgICBjb25zdCBiYXNlRm9sZGVyID0gdGhpcy5maW5kQmFzZVRhc2tGb2xkZXIodGFzay5maWxlKTtcbiAgICAgICAgICAgICAgICBpZiAoIWJhc2VGb2xkZXIpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgICAgICAgY29uc3QgdGFyZ2V0Rm9sZGVyUGF0aCA9IGAke2Jhc2VGb2xkZXIucGF0aH0vJHt0YWd9YDtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICAvLyBDcmVhdGUgdGFyZ2V0IGZvbGRlciBpZiBpdCBkb2Vzbid0IGV4aXN0XG4gICAgICAgICAgICAgICAgICAgIGxldCB0YXJnZXRGb2xkZXIgPSB2YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgodGFyZ2V0Rm9sZGVyUGF0aCk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghdGFyZ2V0Rm9sZGVyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhd2FpdCB2YXVsdC5jcmVhdGVGb2xkZXIodGFyZ2V0Rm9sZGVyUGF0aCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB0YXJnZXRGb2xkZXIgPSB2YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgodGFyZ2V0Rm9sZGVyUGF0aCk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAodGFyZ2V0Rm9sZGVyIGluc3RhbmNlb2YgVEZvbGRlcikge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgbmV3UGF0aCA9IGAke3RhcmdldEZvbGRlclBhdGh9LyR7dGFzay5maWxlLm5hbWV9YDtcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IHZhdWx0LnJlbmFtZSh0YXNrLmZpbGUsIG5ld1BhdGgpO1xuICAgICAgICAgICAgICAgICAgICAgICAgbW92ZWRDb3VudCsrO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5lcnJvcihgRXJyb3IgbW92aW5nIHRhc2sgJHt0YXNrLmZpbGUucGF0aH06YCwgZXJyb3IpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIG5ldyBOb3RpY2UoYE9yZ2FuaXplZCAke21vdmVkQ291bnR9IHRhc2tzIGJ5IHRhZ2ApO1xuICAgICAgICB0aGlzLnJlZnJlc2hWaWV3KCk7XG4gICAgfVxuXG4gICAgLy8gT3JnYW5pemUgdGFza3MgaW4gYSBzcGVjaWZpYyBmb2xkZXIgYnkgdGFnXG4gICAgYXN5bmMgb3JnYW5pemVUYXNrc0luRm9sZGVyKGZvbGRlcjogVEZvbGRlcikge1xuICAgICAgICBjb25zdCBmaWxlcyA9IHRoaXMuY29sbGVjdE1hcmtkb3duRmlsZXMoZm9sZGVyKTtcbiAgICAgICAgbGV0IG1vdmVkQ291bnQgPSAwO1xuICAgICAgICBjb25zdCB2YXVsdCA9IHRoaXMuYXBwLnZhdWx0O1xuXG4gICAgICAgIGZvciAoY29uc3QgZmlsZSBvZiBmaWxlcykge1xuICAgICAgICAgICAgY29uc3QgY2FjaGUgPSB0aGlzLmFwcC5tZXRhZGF0YUNhY2hlLmdldEZpbGVDYWNoZShmaWxlKTtcbiAgICAgICAgICAgIGNvbnN0IHRhZyA9IGNhY2hlPy5mcm9udG1hdHRlcj8udGFnIHx8ICd1bnRhZ2dlZCc7XG5cbiAgICAgICAgICAgIC8vIFNraXAgaWYgYWxyZWFkeSBpbiBjb3JyZWN0IGZvbGRlclxuICAgICAgICAgICAgY29uc3QgY3VycmVudEZvbGRlciA9IGZpbGUucGFyZW50Py5uYW1lO1xuICAgICAgICAgICAgaWYgKGN1cnJlbnRGb2xkZXIgPT09IHRhZykgY29udGludWU7XG5cbiAgICAgICAgICAgIGNvbnN0IHRhcmdldEZvbGRlclBhdGggPSBgJHtmb2xkZXIucGF0aH0vJHt0YWd9YDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAvLyBDcmVhdGUgdGFyZ2V0IGZvbGRlciBpZiBpdCBkb2Vzbid0IGV4aXN0XG4gICAgICAgICAgICAgICAgbGV0IHRhcmdldEZvbGRlciA9IHZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aCh0YXJnZXRGb2xkZXJQYXRoKTtcbiAgICAgICAgICAgICAgICBpZiAoIXRhcmdldEZvbGRlcikge1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCB2YXVsdC5jcmVhdGVGb2xkZXIodGFyZ2V0Rm9sZGVyUGF0aCk7XG4gICAgICAgICAgICAgICAgICAgIHRhcmdldEZvbGRlciA9IHZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aCh0YXJnZXRGb2xkZXJQYXRoKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAodGFyZ2V0Rm9sZGVyIGluc3RhbmNlb2YgVEZvbGRlcikge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBuZXdQYXRoID0gYCR7dGFyZ2V0Rm9sZGVyUGF0aH0vJHtmaWxlLm5hbWV9YDtcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgdmF1bHQucmVuYW1lKGZpbGUsIG5ld1BhdGgpO1xuICAgICAgICAgICAgICAgICAgICBtb3ZlZENvdW50Kys7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmVycm9yKGBFcnJvciBtb3ZpbmcgdGFzayAke2ZpbGUucGF0aH06YCwgZXJyb3IpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbmV3IE5vdGljZShgT3JnYW5pemVkICR7bW92ZWRDb3VudH0gdGFza3MgaW4gJHtmb2xkZXIubmFtZX0gYnkgdGFnYCk7XG4gICAgICAgIHRoaXMucmVmcmVzaFZpZXcoKTtcbiAgICB9XG5cbiAgICAvLyBGaW5kIHRoZSBiYXNlIHRhc2sgZm9sZGVyIGZvciBhIGZpbGVcbiAgICBwcml2YXRlIGZpbmRCYXNlVGFza0ZvbGRlcihmaWxlOiBURmlsZSk6IFRGb2xkZXIgfCBudWxsIHtcbiAgICAgICAgbGV0IGN1cnJlbnQgPSBmaWxlLnBhcmVudDtcbiAgICAgICAgXG4gICAgICAgIHdoaWxlIChjdXJyZW50KSB7XG4gICAgICAgICAgICBpZiAodGhpcy5zZXR0aW5ncy50YXNrRm9sZGVycy5zb21lKHRmID0+IFxuICAgICAgICAgICAgICAgIGN1cnJlbnQhLnBhdGggPT09IHRmIHx8IFxuICAgICAgICAgICAgICAgIGN1cnJlbnQhLnBhdGguZW5kc1dpdGgoJy8nICsgdGYpIHx8XG4gICAgICAgICAgICAgICAgY3VycmVudCEubmFtZSA9PT0gdGZcbiAgICAgICAgICAgICkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gY3VycmVudDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGN1cnJlbnQgPSBjdXJyZW50LnBhcmVudDtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxufVxuXG4vLyBUYXNrIEJvYXJkIFZpZXdcbmNsYXNzIFRhc2tCb2FyZFZpZXcgZXh0ZW5kcyBJdGVtVmlldyB7XG4gICAgcGx1Z2luOiBUYXNrQm9hcmRQbHVnaW47XG4gICAgdGFza3M6IFRhc2tbXSA9IFtdO1xuICAgIGZpbHRlcmVkVGFza3M6IFRhc2tbXSA9IFtdO1xuICAgIGNvbnRhaW5lckVsOiBIVE1MRWxlbWVudDtcbiAgICBzb3J0U2VsZWN0OiBEcm9wZG93bkNvbXBvbmVudDtcbiAgICBzZWxlY3RlZFRhZ3M6IFNldDxzdHJpbmc+ID0gbmV3IFNldCgpO1xuICAgIHRhZ0ZpbHRlckNvbnRhaW5lcjogSFRNTEVsZW1lbnQgfCBudWxsID0gbnVsbDtcbiAgICBoaWRkZW5TdGF0dXNlczogU2V0PHN0cmluZz4gPSBuZXcgU2V0KCk7XG4gICAgc2VhcmNoUXVlcnk6IHN0cmluZyA9ICcnO1xuICAgIHNlYXJjaElucHV0OiBIVE1MSW5wdXRFbGVtZW50IHwgbnVsbCA9IG51bGw7XG5cbiAgICBjb25zdHJ1Y3RvcihsZWFmOiBXb3Jrc3BhY2VMZWFmLCBwbHVnaW46IFRhc2tCb2FyZFBsdWdpbikge1xuICAgICAgICBzdXBlcihsZWFmKTtcbiAgICAgICAgdGhpcy5wbHVnaW4gPSBwbHVnaW47XG4gICAgICAgIC8vIEluaXRpYWxpemUgaGlkZGVuIHN0YXR1c2VzIGZyb20gc2V0dGluZ3NcbiAgICAgICAgdGhpcy5oaWRkZW5TdGF0dXNlcyA9IG5ldyBTZXQodGhpcy5wbHVnaW4uc2V0dGluZ3MuaGlkZGVuU3RhdHVzZXMgfHwgW10pO1xuICAgIH1cblxuICAgIGdldFZpZXdUeXBlKCk6IHN0cmluZyB7XG4gICAgICAgIHJldHVybiBWSUVXX1RZUEVfVEFTS19CT0FSRDtcbiAgICB9XG5cbiAgICBnZXREaXNwbGF5VGV4dCgpOiBzdHJpbmcge1xuICAgICAgICByZXR1cm4gJ1Rhc2sgQm9hcmQnO1xuICAgIH1cblxuICAgIGdldEljb24oKTogc3RyaW5nIHtcbiAgICAgICAgcmV0dXJuICdsYXlvdXQtYm9hcmQnO1xuICAgIH1cblxuICAgIGFzeW5jIG9uT3BlbigpIHtcbiAgICAgICAgdGhpcy5jb250YWluZXJFbCA9IHRoaXMuY29udGVudEVsLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stYm9hcmQtY29udGFpbmVyJyB9KTtcbiAgICAgICAgYXdhaXQgdGhpcy5yZWZyZXNoKCk7XG4gICAgfVxuXG4gICAgYXN5bmMgcmVmcmVzaCgpIHtcbiAgICAgICAgdGhpcy50YXNrcyA9IGF3YWl0IHRoaXMucGx1Z2luLnNjYW5UYXNrcygpO1xuICAgICAgICB0aGlzLmFwcGx5RmlsdGVycygpO1xuICAgICAgICB0aGlzLnJlbmRlcigpO1xuICAgIH1cblxuICAgIC8vIEFwcGx5IHNlYXJjaCBhbmQgdGFnIGZpbHRlcnMgdG8gdGFza3NcbiAgICBhcHBseUZpbHRlcnMoKSB7XG4gICAgICAgIGxldCByZXN1bHQgPSB0aGlzLnRhc2tzO1xuXG4gICAgICAgIC8vIEFwcGx5IHNlYXJjaCBxdWVyeSBmaWx0ZXJcbiAgICAgICAgaWYgKHRoaXMuc2VhcmNoUXVlcnkudHJpbSgpKSB7XG4gICAgICAgICAgICBjb25zdCBxdWVyeSA9IHRoaXMuc2VhcmNoUXVlcnkudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgICAgIHJlc3VsdCA9IHJlc3VsdC5maWx0ZXIodGFzayA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgdGl0bGVNYXRjaCA9IHRhc2sudGl0bGUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhxdWVyeSk7XG4gICAgICAgICAgICAgICAgY29uc3QgdGFnTWF0Y2ggPSB0YXNrLnRhZy50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHF1ZXJ5KTtcbiAgICAgICAgICAgICAgICBjb25zdCBjb250ZW50TWF0Y2ggPSB0YXNrLmNvbnRlbnQudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhxdWVyeSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRpdGxlTWF0Y2ggfHwgdGFnTWF0Y2ggfHwgY29udGVudE1hdGNoO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBBcHBseSB0YWcgZmlsdGVyIChvbmx5IGlmIG5vdCBhbGwgdGFncyBzZWxlY3RlZClcbiAgICAgICAgY29uc3QgYWxsVGFncyA9IHRoaXMuZ2V0QWxsVGFncygpO1xuICAgICAgICBpZiAodGhpcy5zZWxlY3RlZFRhZ3Muc2l6ZSA+IDAgJiYgdGhpcy5zZWxlY3RlZFRhZ3Muc2l6ZSA8IGFsbFRhZ3MubGVuZ3RoKSB7XG4gICAgICAgICAgICByZXN1bHQgPSByZXN1bHQuZmlsdGVyKHRhc2sgPT4gdGhpcy5zZWxlY3RlZFRhZ3MuaGFzKHRhc2sudGFnKSk7XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLmZpbHRlcmVkVGFza3MgPSByZXN1bHQ7XG4gICAgfVxuXG4gICAgcmVuZGVyKCkge1xuICAgICAgICB0aGlzLmNvbnRhaW5lckVsLmVtcHR5KCk7XG5cbiAgICAgICAgLy8gSGVhZGVyIHdpdGggY29udHJvbHNcbiAgICAgICAgdGhpcy5yZW5kZXJIZWFkZXIoKTtcblxuICAgICAgICAvLyBUYWcgZmlsdGVyXG4gICAgICAgIHRoaXMucmVuZGVyVGFnRmlsdGVyKCk7XG5cbiAgICAgICAgLy8gQm9hcmRcbiAgICAgICAgdGhpcy5yZW5kZXJCb2FyZCgpO1xuICAgIH1cblxuICAgIHJlbmRlckhlYWRlcigpIHtcbiAgICAgICAgY29uc3QgaGVhZGVyID0gdGhpcy5jb250YWluZXJFbC5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLWJvYXJkLWhlYWRlcicgfSk7XG5cbiAgICAgICAgLy8gVGl0bGVcbiAgICAgICAgaGVhZGVyLmNyZWF0ZUVsKCdoMicsIHsgdGV4dDogJ1Rhc2sgQm9hcmQnLCBjbHM6ICd0YXNrLWJvYXJkLXRpdGxlJyB9KTtcblxuICAgICAgICAvLyBTZWFyY2ggYmFyXG4gICAgICAgIGNvbnN0IHNlYXJjaENvbnRhaW5lciA9IGhlYWRlci5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLXNlYXJjaC1jb250YWluZXInIH0pO1xuICAgICAgICBjb25zdCBzZWFyY2hJbnB1dCA9IHNlYXJjaENvbnRhaW5lci5jcmVhdGVFbCgnaW5wdXQnLCB7XG4gICAgICAgICAgICB0eXBlOiAndGV4dCcsXG4gICAgICAgICAgICBwbGFjZWhvbGRlcjogJ1NlYXJjaCB0YXNrcy4uLicsXG4gICAgICAgICAgICBjbHM6ICd0YXNrLXNlYXJjaC1pbnB1dCdcbiAgICAgICAgfSk7XG4gICAgICAgIHNlYXJjaElucHV0LnZhbHVlID0gdGhpcy5zZWFyY2hRdWVyeTtcbiAgICAgICAgXG4gICAgICAgIC8vIFNlYXJjaCBpY29uXG4gICAgICAgIGNvbnN0IHNlYXJjaEljb24gPSBzZWFyY2hDb250YWluZXIuY3JlYXRlU3Bhbih7IGNsczogJ3Rhc2stc2VhcmNoLWljb24nLCB0ZXh0OiAn8J+UjScgfSk7XG4gICAgICAgIFxuICAgICAgICAvLyBSZWFsLXRpbWUgc2VhcmNoIHdpdGggbWluaW1hbCBkZWJvdW5jZVxuICAgICAgICBsZXQgZGVib3VuY2VUaW1lcjogbnVtYmVyO1xuICAgICAgICBzZWFyY2hJbnB1dC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIChlKSA9PiB7XG4gICAgICAgICAgICBjbGVhclRpbWVvdXQoZGVib3VuY2VUaW1lcik7XG4gICAgICAgICAgICB0aGlzLnNlYXJjaFF1ZXJ5ID0gc2VhcmNoSW5wdXQudmFsdWU7XG4gICAgICAgICAgICB0aGlzLmFwcGx5RmlsdGVycygpO1xuICAgICAgICAgICAgdGhpcy5yZW5kZXJCb2FyZCgpO1xuICAgICAgICB9KTtcbiAgICAgICAgXG4gICAgICAgIC8vIENsZWFyIGJ1dHRvbiAodmlzaWJsZSB3aGVuIHNlYXJjaCBoYXMgdGV4dClcbiAgICAgICAgaWYgKHRoaXMuc2VhcmNoUXVlcnkpIHtcbiAgICAgICAgICAgIGNvbnN0IGNsZWFyU2VhcmNoQnRuID0gc2VhcmNoQ29udGFpbmVyLmNyZWF0ZUVsKCdidXR0b24nLCB7XG4gICAgICAgICAgICAgICAgY2xzOiAndGFzay1zZWFyY2gtY2xlYXInLFxuICAgICAgICAgICAgICAgIHRleHQ6ICfinJUnXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGNsZWFyU2VhcmNoQnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICAgICAgICAgIHRoaXMuc2VhcmNoUXVlcnkgPSAnJztcbiAgICAgICAgICAgICAgICB0aGlzLmFwcGx5RmlsdGVycygpO1xuICAgICAgICAgICAgICAgIHRoaXMucmVuZGVyKCk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENvbnRyb2xzXG4gICAgICAgIGNvbnN0IGNvbnRyb2xzID0gaGVhZGVyLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stYm9hcmQtY29udHJvbHMnIH0pO1xuXG4gICAgICAgIC8vIFNvcnQgZHJvcGRvd25cbiAgICAgICAgY29udHJvbHMuY3JlYXRlU3Bhbih7IHRleHQ6ICdTb3J0IGJ5OiAnLCBjbHM6ICd0YXNrLWJvYXJkLWxhYmVsJyB9KTtcbiAgICAgICAgY29uc3Qgc29ydFNlbGVjdCA9IG5ldyBEcm9wZG93bkNvbXBvbmVudChjb250cm9scyk7XG4gICAgICAgIHNvcnRTZWxlY3QuYWRkT3B0aW9uKCdwcmlvcml0eScsICdQcmlvcml0eScpO1xuICAgICAgICBzb3J0U2VsZWN0LmFkZE9wdGlvbigndGFnJywgJ1RhZycpO1xuICAgICAgICBzb3J0U2VsZWN0LmFkZE9wdGlvbigndGl0bGUnLCAnVGl0bGUnKTtcbiAgICAgICAgc29ydFNlbGVjdC5hZGRPcHRpb24oJ2ZvbGRlcicsICdGb2xkZXInKTtcbiAgICAgICAgc29ydFNlbGVjdC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5zb3J0QnkpO1xuICAgICAgICBzb3J0U2VsZWN0Lm9uQ2hhbmdlKCh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3Muc29ydEJ5ID0gdmFsdWUgYXMgYW55O1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgICB0aGlzLnJlbmRlckJvYXJkKCk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIFNvcnQgZGlyZWN0aW9uXG4gICAgICAgIGNvbnN0IGRpckJ0biA9IGNvbnRyb2xzLmNyZWF0ZUVsKCdidXR0b24nLCB7XG4gICAgICAgICAgICBjbHM6ICd0YXNrLWJvYXJkLXNvcnQtZGlyJyxcbiAgICAgICAgICAgIHRleHQ6IHRoaXMucGx1Z2luLnNldHRpbmdzLnNvcnREaXJlY3Rpb24gPT09ICdhc2MnID8gJ+KGkScgOiAn4oaTJ1xuICAgICAgICB9KTtcbiAgICAgICAgZGlyQnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3Muc29ydERpcmVjdGlvbiA9IFxuICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLnNvcnREaXJlY3Rpb24gPT09ICdhc2MnID8gJ2Rlc2MnIDogJ2FzYyc7XG4gICAgICAgICAgICBkaXJCdG4udGV4dENvbnRlbnQgPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zb3J0RGlyZWN0aW9uID09PSAnYXNjJyA/ICfihpEnIDogJ+KGkyc7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyQm9hcmQoKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gQ29sdW1uIHZpc2liaWxpdHkgdG9nZ2xlc1xuICAgICAgICBjb25zdCB2aXNpYmlsaXR5Q29udHJvbHMgPSBjb250cm9scy5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLWJvYXJkLXZpc2liaWxpdHknIH0pO1xuICAgICAgICB2aXNpYmlsaXR5Q29udHJvbHMuY3JlYXRlU3Bhbih7IHRleHQ6ICdTaG93OiAnLCBjbHM6ICd0YXNrLWJvYXJkLWxhYmVsJyB9KTtcblxuICAgICAgICAvLyBUb2dnbGUgZm9yIERvbmUgY29sdW1uXG4gICAgICAgIGNvbnN0IGRvbmVMYWJlbCA9IHZpc2liaWxpdHlDb250cm9scy5jcmVhdGVFbCgnbGFiZWwnLCB7IGNsczogJ3Zpc2liaWxpdHktdG9nZ2xlJyB9KTtcbiAgICAgICAgY29uc3QgZG9uZUNoZWNrYm94ID0gZG9uZUxhYmVsLmNyZWF0ZUVsKCdpbnB1dCcsIHtcbiAgICAgICAgICAgIHR5cGU6ICdjaGVja2JveCcsXG4gICAgICAgICAgICBjbHM6ICd2aXNpYmlsaXR5LWNoZWNrYm94J1xuICAgICAgICB9KTtcbiAgICAgICAgZG9uZUNoZWNrYm94LmNoZWNrZWQgPSAhdGhpcy5oaWRkZW5TdGF0dXNlcy5oYXMoJ2RvbmUnKTtcbiAgICAgICAgZG9uZUxhYmVsLmNyZWF0ZVNwYW4oeyB0ZXh0OiAnRG9uZScsIGNsczogJ3Zpc2liaWxpdHktdGV4dCcgfSk7XG4gICAgICAgIGRvbmVDaGVja2JveC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7XG4gICAgICAgICAgICBpZiAoZG9uZUNoZWNrYm94LmNoZWNrZWQpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmhpZGRlblN0YXR1c2VzLmRlbGV0ZSgnZG9uZScpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLmhpZGRlblN0YXR1c2VzLmFkZCgnZG9uZScpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MuaGlkZGVuU3RhdHVzZXMgPSBBcnJheS5mcm9tKHRoaXMuaGlkZGVuU3RhdHVzZXMpO1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgICB0aGlzLnJlbmRlckJvYXJkKCk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIFRvZ2dsZSBmb3IgQXJjaGl2ZSBjb2x1bW5cbiAgICAgICAgY29uc3QgYXJjaGl2ZUxhYmVsID0gdmlzaWJpbGl0eUNvbnRyb2xzLmNyZWF0ZUVsKCdsYWJlbCcsIHsgY2xzOiAndmlzaWJpbGl0eS10b2dnbGUnIH0pO1xuICAgICAgICBjb25zdCBhcmNoaXZlQ2hlY2tib3ggPSBhcmNoaXZlTGFiZWwuY3JlYXRlRWwoJ2lucHV0Jywge1xuICAgICAgICAgICAgdHlwZTogJ2NoZWNrYm94JyxcbiAgICAgICAgICAgIGNsczogJ3Zpc2liaWxpdHktY2hlY2tib3gnXG4gICAgICAgIH0pO1xuICAgICAgICBhcmNoaXZlQ2hlY2tib3guY2hlY2tlZCA9ICF0aGlzLmhpZGRlblN0YXR1c2VzLmhhcygnYXJjaGl2ZScpO1xuICAgICAgICBhcmNoaXZlTGFiZWwuY3JlYXRlU3Bhbih7IHRleHQ6ICdBcmNoaXZlJywgY2xzOiAndmlzaWJpbGl0eS10ZXh0JyB9KTtcbiAgICAgICAgYXJjaGl2ZUNoZWNrYm94LmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHtcbiAgICAgICAgICAgIGlmIChhcmNoaXZlQ2hlY2tib3guY2hlY2tlZCkge1xuICAgICAgICAgICAgICAgIHRoaXMuaGlkZGVuU3RhdHVzZXMuZGVsZXRlKCdhcmNoaXZlJyk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMuaGlkZGVuU3RhdHVzZXMuYWRkKCdhcmNoaXZlJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5oaWRkZW5TdGF0dXNlcyA9IEFycmF5LmZyb20odGhpcy5oaWRkZW5TdGF0dXNlcyk7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyQm9hcmQoKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gT3JnYW5pemUgYnkgdGFnIGJ1dHRvblxuICAgICAgICBjb25zdCBvcmdhbml6ZUJ0biA9IGNvbnRyb2xzLmNyZWF0ZUVsKCdidXR0b24nLCB7XG4gICAgICAgICAgICBjbHM6ICd0YXNrLWJvYXJkLW9yZ2FuaXplJyxcbiAgICAgICAgICAgIHRleHQ6ICfwn5OBIE9yZ2FuaXplJ1xuICAgICAgICB9KTtcbiAgICAgICAgb3JnYW5pemVCdG4udGl0bGUgPSAnT3JnYW5pemUgdGFza3MgYnkgdGFnJztcbiAgICAgICAgb3JnYW5pemVCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5vcmdhbml6ZVRhc2tzQnlUYWcoKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gUmVmcmVzaCBidXR0b25cbiAgICAgICAgY29uc3QgcmVmcmVzaEJ0biA9IGNvbnRyb2xzLmNyZWF0ZUVsKCdidXR0b24nLCB7XG4gICAgICAgICAgICBjbHM6ICd0YXNrLWJvYXJkLXJlZnJlc2gnLFxuICAgICAgICAgICAgdGV4dDogJ/CflIQnXG4gICAgICAgIH0pO1xuICAgICAgICByZWZyZXNoQnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdGhpcy5yZWZyZXNoKCkpO1xuXG4gICAgICAgIC8vIENsZWFyIGZpbHRlcnMgYnV0dG9uIChoaWRkZW4gYnkgZGVmYXVsdClcbiAgICAgICAgY29uc3QgY2xlYXJCdG4gPSBjb250cm9scy5jcmVhdGVFbCgnYnV0dG9uJywge1xuICAgICAgICAgICAgY2xzOiAndGFzay1ib2FyZC1jbGVhci1maWx0ZXJzJyxcbiAgICAgICAgICAgIHRleHQ6ICfinJUgQ2xlYXInXG4gICAgICAgIH0pO1xuICAgICAgICBjbGVhckJ0bi5zdHlsZS5kaXNwbGF5ID0gdGhpcy5zZWxlY3RlZFRhZ3Muc2l6ZSA+IDAgPyAnaW5saW5lLWJsb2NrJyA6ICdub25lJztcbiAgICAgICAgY2xlYXJCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnNlbGVjdGVkVGFncy5jbGVhcigpO1xuICAgICAgICAgICAgdGhpcy5yZW5kZXJUYWdGaWx0ZXIoKTtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyQm9hcmQoKTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gR2V0IGFsbCB1bmlxdWUgdGFncyBmcm9tIHRhc2tzXG4gICAgZ2V0QWxsVGFncygpOiBzdHJpbmdbXSB7XG4gICAgICAgIGNvbnN0IHRhZ3MgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICAgICAgZm9yIChjb25zdCB0YXNrIG9mIHRoaXMudGFza3MpIHtcbiAgICAgICAgICAgIGlmICh0YXNrLnRhZykge1xuICAgICAgICAgICAgICAgIHRhZ3MuYWRkKHRhc2sudGFnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gQXJyYXkuZnJvbSh0YWdzKS5zb3J0KCk7XG4gICAgfVxuXG4gICAgLy8gUmVuZGVyIHRhZyBmaWx0ZXIgY2hlY2tib3hlc1xuICAgIHJlbmRlclRhZ0ZpbHRlcigpIHtcbiAgICAgICAgLy8gUmVtb3ZlIGV4aXN0aW5nIGZpbHRlciBpZiBhbnlcbiAgICAgICAgaWYgKHRoaXMudGFnRmlsdGVyQ29udGFpbmVyKSB7XG4gICAgICAgICAgICB0aGlzLnRhZ0ZpbHRlckNvbnRhaW5lci5yZW1vdmUoKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHRhZ3MgPSB0aGlzLmdldEFsbFRhZ3MoKTtcbiAgICAgICAgaWYgKHRhZ3MubGVuZ3RoID09PSAwKSByZXR1cm47XG5cbiAgICAgICAgLy8gQXV0by1zZWxlY3QgYWxsIHRhZ3MgaWYgbm9uZSBzZWxlY3RlZCAoZGVmYXVsdCBiZWhhdmlvcilcbiAgICAgICAgaWYgKHRoaXMuc2VsZWN0ZWRUYWdzLnNpemUgPT09IDApIHtcbiAgICAgICAgICAgIHRhZ3MuZm9yRWFjaCh0YWcgPT4gdGhpcy5zZWxlY3RlZFRhZ3MuYWRkKHRhZykpO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy50YWdGaWx0ZXJDb250YWluZXIgPSB0aGlzLmNvbnRhaW5lckVsLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stdGFnLWZpbHRlcicgfSk7XG4gICAgICAgIFxuICAgICAgICBjb25zdCBmaWx0ZXJIZWFkZXIgPSB0aGlzLnRhZ0ZpbHRlckNvbnRhaW5lci5jcmVhdGVEaXYoeyBjbHM6ICd0YWctZmlsdGVyLWhlYWRlcicgfSk7XG4gICAgICAgIGZpbHRlckhlYWRlci5jcmVhdGVTcGFuKHsgdGV4dDogJ0ZpbHRlciBieSB0YWc6JywgY2xzOiAndGFnLWZpbHRlci1sYWJlbCcgfSk7XG5cbiAgICAgICAgLy8gU2VsZWN0IGFsbCAvIERlc2VsZWN0IGFsbCBidXR0b25zXG4gICAgICAgIGNvbnN0IGJ0bkdyb3VwID0gZmlsdGVySGVhZGVyLmNyZWF0ZURpdih7IGNsczogJ3RhZy1maWx0ZXItYnV0dG9ucycgfSk7XG4gICAgICAgIFxuICAgICAgICBjb25zdCBzZWxlY3RBbGxCdG4gPSBidG5Hcm91cC5jcmVhdGVFbCgnYnV0dG9uJywge1xuICAgICAgICAgICAgdGV4dDogJ0FsbCcsXG4gICAgICAgICAgICBjbHM6ICd0YWctZmlsdGVyLWJ0bidcbiAgICAgICAgfSk7XG4gICAgICAgIHNlbGVjdEFsbEJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgICAgIHRhZ3MuZm9yRWFjaCh0YWcgPT4gdGhpcy5zZWxlY3RlZFRhZ3MuYWRkKHRhZykpO1xuICAgICAgICAgICAgdGhpcy5yZW5kZXJUYWdGaWx0ZXIoKTtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyQm9hcmQoKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgY29uc3QgZGVzZWxlY3RBbGxCdG4gPSBidG5Hcm91cC5jcmVhdGVFbCgnYnV0dG9uJywge1xuICAgICAgICAgICAgdGV4dDogJ05vbmUnLFxuICAgICAgICAgICAgY2xzOiAndGFnLWZpbHRlci1idG4nXG4gICAgICAgIH0pO1xuICAgICAgICBkZXNlbGVjdEFsbEJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgICAgIHRoaXMuc2VsZWN0ZWRUYWdzLmNsZWFyKCk7XG4gICAgICAgICAgICB0aGlzLnJlbmRlclRhZ0ZpbHRlcigpO1xuICAgICAgICAgICAgdGhpcy5yZW5kZXJCb2FyZCgpO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBDaGVja2JveCBjb250YWluZXJcbiAgICAgICAgY29uc3QgY2hlY2tib3hDb250YWluZXIgPSB0aGlzLnRhZ0ZpbHRlckNvbnRhaW5lci5jcmVhdGVEaXYoeyBjbHM6ICd0YWctY2hlY2tib3gtY29udGFpbmVyJyB9KTtcblxuICAgICAgICBmb3IgKGNvbnN0IHRhZyBvZiB0YWdzKSB7XG4gICAgICAgICAgICBjb25zdCBsYWJlbCA9IGNoZWNrYm94Q29udGFpbmVyLmNyZWF0ZUVsKCdsYWJlbCcsIHsgY2xzOiAndGFnLWNoZWNrYm94LWxhYmVsJyB9KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29uc3QgY2hlY2tib3ggPSBsYWJlbC5jcmVhdGVFbCgnaW5wdXQnLCB7XG4gICAgICAgICAgICAgICAgdHlwZTogJ2NoZWNrYm94JyxcbiAgICAgICAgICAgICAgICBjbHM6ICd0YWctY2hlY2tib3gnXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGNoZWNrYm94LmNoZWNrZWQgPSB0aGlzLnNlbGVjdGVkVGFncy5oYXModGFnKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgbGFiZWwuY3JlYXRlU3Bhbih7IHRleHQ6IHRhZywgY2xzOiAndGFnLWNoZWNrYm94LXRleHQnIH0pO1xuXG4gICAgICAgICAgICAvLyBDb3VudCB0YXNrcyB3aXRoIHRoaXMgdGFnXG4gICAgICAgICAgICBjb25zdCBjb3VudCA9IHRoaXMudGFza3MuZmlsdGVyKHQgPT4gdC50YWcgPT09IHRhZykubGVuZ3RoO1xuICAgICAgICAgICAgbGFiZWwuY3JlYXRlU3Bhbih7IHRleHQ6IGAoJHtjb3VudH0pYCwgY2xzOiAndGFnLWNoZWNrYm94LWNvdW50JyB9KTtcblxuICAgICAgICAgICAgY2hlY2tib3guYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChjaGVja2JveC5jaGVja2VkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuc2VsZWN0ZWRUYWdzLmFkZCh0YWcpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuc2VsZWN0ZWRUYWdzLmRlbGV0ZSh0YWcpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB0aGlzLmFwcGx5RmlsdGVycygpO1xuICAgICAgICAgICAgICAgIHRoaXMucmVuZGVyQm9hcmQoKTtcbiAgICAgICAgICAgICAgICAvLyBVcGRhdGUgY2xlYXIgYnV0dG9uIHZpc2liaWxpdHlcbiAgICAgICAgICAgICAgICBjb25zdCBjbGVhckJ0biA9IHRoaXMuY29udGFpbmVyRWwucXVlcnlTZWxlY3RvcignLnRhc2stYm9hcmQtY2xlYXItZmlsdGVycycpIGFzIEhUTUxFbGVtZW50O1xuICAgICAgICAgICAgICAgIGlmIChjbGVhckJ0bikge1xuICAgICAgICAgICAgICAgICAgICBjbGVhckJ0bi5zdHlsZS5kaXNwbGF5ID0gdGhpcy5zZWxlY3RlZFRhZ3Muc2l6ZSA+IDAgPyAnaW5saW5lLWJsb2NrJyA6ICdub25lJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJlbmRlckJvYXJkKCkge1xuICAgICAgICAvLyBSZW1vdmUgZXhpc3RpbmcgYm9hcmQgaWYgYW55XG4gICAgICAgIGNvbnN0IGV4aXN0aW5nQm9hcmQgPSB0aGlzLmNvbnRhaW5lckVsLnF1ZXJ5U2VsZWN0b3IoJy50YXNrLWJvYXJkJyk7XG4gICAgICAgIGlmIChleGlzdGluZ0JvYXJkKSBleGlzdGluZ0JvYXJkLnJlbW92ZSgpO1xuXG4gICAgICAgIGNvbnN0IGJvYXJkID0gdGhpcy5jb250YWluZXJFbC5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLWJvYXJkJyB9KTtcblxuICAgICAgICAvLyBVc2UgcHJlLWZpbHRlcmVkIHRhc2tzIChzZWFyY2ggKyB0YWcgZmlsdGVycyBhbHJlYWR5IGFwcGxpZWQpXG4gICAgICAgIGNvbnN0IHRhc2tzVG9SZW5kZXIgPSB0aGlzLmZpbHRlcmVkVGFza3M7XG5cbiAgICAgICAgLy8gR3JvdXAgdGFza3MgYnkgc3RhdHVzXG4gICAgICAgIGNvbnN0IHRhc2tzQnlTdGF0dXMgPSBuZXcgTWFwPHN0cmluZywgVGFza1tdPigpO1xuICAgICAgICBcbiAgICAgICAgLy8gSW5pdGlhbGl6ZSB3aXRoIGNvbmZpZ3VyZWQgc3RhdHVzIG9yZGVyXG4gICAgICAgIGZvciAoY29uc3Qgc3RhdHVzIG9mIHRoaXMucGx1Z2luLnNldHRpbmdzLnN0YXR1c09yZGVyKSB7XG4gICAgICAgICAgICB0YXNrc0J5U3RhdHVzLnNldChzdGF0dXMsIFtdKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEdyb3VwIHRhc2tzXG4gICAgICAgIGZvciAoY29uc3QgdGFzayBvZiB0YXNrc1RvUmVuZGVyKSB7XG4gICAgICAgICAgICBjb25zdCBzdGF0dXMgPSB0YXNrLnN0YXR1cyB8fCB0aGlzLnBsdWdpbi5zZXR0aW5ncy5kZWZhdWx0U3RhdHVzO1xuICAgICAgICAgICAgaWYgKCF0YXNrc0J5U3RhdHVzLmhhcyhzdGF0dXMpKSB7XG4gICAgICAgICAgICAgICAgdGFza3NCeVN0YXR1cy5zZXQoc3RhdHVzLCBbXSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0YXNrc0J5U3RhdHVzLmdldChzdGF0dXMpIS5wdXNoKHRhc2spO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQ3JlYXRlIGNvbHVtbnMgKHNraXAgaGlkZGVuIHN0YXR1c2VzKVxuICAgICAgICBmb3IgKGNvbnN0IHN0YXR1cyBvZiB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zdGF0dXNPcmRlcikge1xuICAgICAgICAgICAgaWYgKHRoaXMuaGlkZGVuU3RhdHVzZXMuaGFzKHN0YXR1cykpIGNvbnRpbnVlO1xuICAgICAgICAgICAgY29uc3QgdGFza3MgPSB0YXNrc0J5U3RhdHVzLmdldChzdGF0dXMpIHx8IFtdO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICAvLyBGb3IgYWN0aXZlIGNvbHVtbnMgKHRvZG8sIGluLXByb2dyZXNzKSwgdXNlIGhpZXJhcmNoaWNhbCBncm91cGluZ1xuICAgICAgICAgICAgaWYgKHN0YXR1cyA9PT0gJ3RvZG8nIHx8IHN0YXR1cyA9PT0gJ2luLXByb2dyZXNzJykge1xuICAgICAgICAgICAgICAgIHRoaXMucmVuZGVySGllcmFyY2hpY2FsQ29sdW1uKGJvYXJkLCBzdGF0dXMsIHRhc2tzKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgLy8gU29ydCBhbmQgcmVuZGVyIGZsYXQgZm9yIGRvbmUvYXJjaGl2ZSBjb2x1bW5zXG4gICAgICAgICAgICAgICAgdGhpcy5zb3J0VGFza3ModGFza3MpO1xuICAgICAgICAgICAgICAgIHRoaXMucmVuZGVyQ29sdW1uKGJvYXJkLCBzdGF0dXMsIHRhc2tzKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIEdyb3VwIHRhc2tzIGJ5IGZvbGRlciwgdGhlbiBieSB0YWdcbiAgICBncm91cFRhc2tzSGllcmFyY2hpY2FsbHkodGFza3M6IFRhc2tbXSk6IE1hcDxzdHJpbmcsIE1hcDxzdHJpbmcsIFRhc2tbXT4+IHtcbiAgICAgICAgY29uc3QgZm9sZGVyR3JvdXBzID0gbmV3IE1hcDxzdHJpbmcsIE1hcDxzdHJpbmcsIFRhc2tbXT4+KCk7XG5cbiAgICAgICAgZm9yIChjb25zdCB0YXNrIG9mIHRhc2tzKSB7XG4gICAgICAgICAgICBjb25zdCBmb2xkZXIgPSB0YXNrLmZvbGRlciB8fCAnVW5jYXRlZ29yaXplZCc7XG4gICAgICAgICAgICBjb25zdCB0YWcgPSB0YXNrLnRhZyB8fCAndW50YWdnZWQnO1xuXG4gICAgICAgICAgICBpZiAoIWZvbGRlckdyb3Vwcy5oYXMoZm9sZGVyKSkge1xuICAgICAgICAgICAgICAgIGZvbGRlckdyb3Vwcy5zZXQoZm9sZGVyLCBuZXcgTWFwKCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgdGFnR3JvdXBzID0gZm9sZGVyR3JvdXBzLmdldChmb2xkZXIpITtcblxuICAgICAgICAgICAgaWYgKCF0YWdHcm91cHMuaGFzKHRhZykpIHtcbiAgICAgICAgICAgICAgICB0YWdHcm91cHMuc2V0KHRhZywgW10pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGFnR3JvdXBzLmdldCh0YWcpIS5wdXNoKHRhc2spO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gU29ydCB0YXNrcyB3aXRoaW4gZWFjaCB0YWcgZ3JvdXBcbiAgICAgICAgZm9yIChjb25zdCBbZm9sZGVyLCB0YWdHcm91cHNdIG9mIGZvbGRlckdyb3Vwcykge1xuICAgICAgICAgICAgZm9yIChjb25zdCBbdGFnLCB0YWdUYXNrc10gb2YgdGFnR3JvdXBzKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5zb3J0VGFza3ModGFnVGFza3MpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGZvbGRlckdyb3VwcztcbiAgICB9XG5cbiAgICByZW5kZXJIaWVyYXJjaGljYWxDb2x1bW4oYm9hcmQ6IEhUTUxFbGVtZW50LCBzdGF0dXM6IHN0cmluZywgdGFza3M6IFRhc2tbXSkge1xuICAgICAgICBjb25zdCBjb2x1bW4gPSBib2FyZC5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLWJvYXJkLWNvbHVtbiBoaWVyYXJjaGljYWwnIH0pO1xuICAgICAgICBjb2x1bW4uc2V0QXR0cmlidXRlKCdkYXRhLXN0YXR1cycsIHN0YXR1cyk7XG5cbiAgICAgICAgLy8gR3JvdXAgdGFza3MgaGllcmFyY2hpY2FsbHlcbiAgICAgICAgY29uc3QgZm9sZGVyR3JvdXBzID0gdGhpcy5ncm91cFRhc2tzSGllcmFyY2hpY2FsbHkodGFza3MpO1xuXG4gICAgICAgIC8vIENhbGN1bGF0ZSBkeW5hbWljIHdpZHRoIGJhc2VkIG9uIG51bWJlciBvZiB0YWdzIGFuZCBmb2xkZXJzXG4gICAgICAgIGNvbnN0IGNvbHVtbldpZHRoID0gdGhpcy5jYWxjdWxhdGVDb2x1bW5XaWR0aChmb2xkZXJHcm91cHMpO1xuICAgICAgICBjb2x1bW4uc3R5bGUud2lkdGggPSBgJHtjb2x1bW5XaWR0aH1weGA7XG4gICAgICAgIGNvbHVtbi5zdHlsZS5taW5XaWR0aCA9IGAke2NvbHVtbldpZHRofXB4YDtcbiAgICAgICAgY29sdW1uLnN0eWxlLmZsZXggPSBgMCAwICR7Y29sdW1uV2lkdGh9cHhgO1xuXG4gICAgICAgIC8vIENvbHVtbiBoZWFkZXIgd2l0aCBkcm9wIHpvbmUgZm9yIHN0YXR1cyBjaGFuZ2VcbiAgICAgICAgY29uc3QgaGVhZGVyID0gY29sdW1uLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stY29sdW1uLWhlYWRlcicgfSk7XG4gICAgICAgIGNvbnN0IHN0YXR1c0xhYmVsID0gdGhpcy5nZXRTdGF0dXNMYWJlbChzdGF0dXMpO1xuICAgICAgICBoZWFkZXIuY3JlYXRlRWwoJ2gzJywgeyB0ZXh0OiBzdGF0dXNMYWJlbCwgY2xzOiBgdGFzay1jb2x1bW4tdGl0bGUgc3RhdHVzLSR7c3RhdHVzfWAgfSk7XG4gICAgICAgIGhlYWRlci5jcmVhdGVTcGFuKHsgdGV4dDogYCR7dGFza3MubGVuZ3RofWAsIGNsczogJ3Rhc2stY291bnQnIH0pO1xuICAgICAgICBcbiAgICAgICAgLy8gTWFrZSBlbnRpcmUgY29sdW1uIGEgZHJvcCB6b25lIGZvciBzdGF0dXNcbiAgICAgICAgdGhpcy5zZXR1cERyb3Bab25lKGNvbHVtbiwgJ3N0YXR1cycsIHN0YXR1cyk7XG5cbiAgICAgICAgLy8gVGFza3MgY29udGFpbmVyIHdpdGggaG9yaXpvbnRhbCBsYXlvdXRcbiAgICAgICAgY29uc3QgdGFza3NDb250YWluZXIgPSBjb2x1bW4uY3JlYXRlRGl2KHsgY2xzOiAndGFzay1jb2x1bW4tdGFza3MgaGllcmFyY2hpY2FsJyB9KTtcblxuICAgICAgICAvLyBTb3J0IGZvbGRlcnMgYWxwaGFiZXRpY2FsbHlcbiAgICAgICAgY29uc3Qgc29ydGVkRm9sZGVycyA9IEFycmF5LmZyb20oZm9sZGVyR3JvdXBzLmtleXMoKSkuc29ydCgpO1xuXG4gICAgICAgIC8vIFJlbmRlciBlYWNoIGZvbGRlclxuICAgICAgICBmb3IgKGNvbnN0IGZvbGRlck5hbWUgb2Ygc29ydGVkRm9sZGVycykge1xuICAgICAgICAgICAgY29uc3QgdGFnR3JvdXBzID0gZm9sZGVyR3JvdXBzLmdldChmb2xkZXJOYW1lKSE7XG4gICAgICAgICAgICAvLyBDYWxjdWxhdGUgZm9sZGVyIHNlY3Rpb24gd2lkdGggYmFzZWQgb24gdGFnc1xuICAgICAgICAgICAgY29uc3QgZm9sZGVyV2lkdGggPSB0aGlzLmNhbGN1bGF0ZUZvbGRlcldpZHRoKHRhZ0dyb3Vwcyk7XG4gICAgICAgICAgICB0aGlzLnJlbmRlckZvbGRlclNlY3Rpb24odGFza3NDb250YWluZXIsIGZvbGRlck5hbWUsIHRhZ0dyb3VwcywgZm9sZGVyV2lkdGgsIHN0YXR1cyk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBFbXB0eSBzdGF0ZVxuICAgICAgICBpZiAodGFza3MubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICB0YXNrc0NvbnRhaW5lci5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLWVtcHR5JywgdGV4dDogJ05vIHRhc2tzJyB9KTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIENhbGN1bGF0ZSBvcHRpbWFsIGNvbHVtbiB3aWR0aCBiYXNlZCBvbiBmb2xkZXIgYW5kIHRhZyBjb3VudHNcbiAgICBjYWxjdWxhdGVDb2x1bW5XaWR0aChmb2xkZXJHcm91cHM6IE1hcDxzdHJpbmcsIE1hcDxzdHJpbmcsIFRhc2tbXT4+KTogbnVtYmVyIHtcbiAgICAgICAgY29uc3QgVEFHX1dJRFRIID0gMjAwOyAgICAgIC8vIFdpZHRoIHBlciB0YWcgZ3JvdXAgKGluY2x1ZGluZyBwYWRkaW5nICYgYm9yZGVyKVxuICAgICAgICBjb25zdCBUQUdfR0FQID0gMTI7ICAgICAgICAgLy8gR2FwIGJldHdlZW4gdGFnc1xuICAgICAgICBjb25zdCBTRUNUSU9OX1BBRERJTkcgPSA0ODsgLy8gRm9sZGVyIHNlY3Rpb24gaW50ZXJuYWwgcGFkZGluZyAoMTZweCAqIDIgKyBtYXJnaW4pXG4gICAgICAgIGNvbnN0IENPTFVNTl9QQURESU5HID0gNDg7ICAvLyBDb2x1bW4gY29udGVudCBwYWRkaW5nICgxMnB4ICogMiArIGV4dHJhKVxuICAgICAgICBjb25zdCBNSU5fV0lEVEggPSA0MDA7ICAgICAgLy8gTWluaW11bSBjb2x1bW4gd2lkdGhcblxuICAgICAgICBsZXQgbWF4Rm9sZGVyV2lkdGggPSAwO1xuXG4gICAgICAgIC8vIENhbGN1bGF0ZSB3aWR0aCBmb3IgZWFjaCBmb2xkZXIgKGFsbCB0YWdzIGluIG9uZSBsaW5lKVxuICAgICAgICBmb3IgKGNvbnN0IFtmb2xkZXIsIHRhZ0dyb3Vwc10gb2YgZm9sZGVyR3JvdXBzKSB7XG4gICAgICAgICAgICBjb25zdCB0YWdDb3VudCA9IHRhZ0dyb3Vwcy5zaXplO1xuICAgICAgICAgICAgLy8gQWNjb3VudCBmb3IgdGFncywgZ2FwcyBiZXR3ZWVuIHRoZW0sIGFuZCBjb250YWluZXIgcGFkZGluZ1xuICAgICAgICAgICAgY29uc3QgY29udGVudFdpZHRoID0gKHRhZ0NvdW50ICogVEFHX1dJRFRIKSArICgodGFnQ291bnQgLSAxKSAqIFRBR19HQVApO1xuICAgICAgICAgICAgY29uc3QgZm9sZGVyV2lkdGggPSBjb250ZW50V2lkdGggKyBTRUNUSU9OX1BBRERJTkc7XG4gICAgICAgICAgICBtYXhGb2xkZXJXaWR0aCA9IE1hdGgubWF4KG1heEZvbGRlcldpZHRoLCBmb2xkZXJXaWR0aCk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBSZXR1cm4gdGhlIHdpZHRoIG5lZWRlZCBmb3IgdGhlIHdpZGVzdCBmb2xkZXIgcGx1cyBjb2x1bW4gcGFkZGluZ1xuICAgICAgICByZXR1cm4gTWF0aC5tYXgoTUlOX1dJRFRILCBtYXhGb2xkZXJXaWR0aCArIENPTFVNTl9QQURESU5HKTtcbiAgICB9XG5cbiAgICAvLyBDYWxjdWxhdGUgZm9sZGVyIHNlY3Rpb24gd2lkdGggLSBtYXRjaGVzIGNvbHVtbiB3aWR0aCBjYWxjdWxhdGlvblxuICAgIGNhbGN1bGF0ZUZvbGRlcldpZHRoKHRhZ0dyb3VwczogTWFwPHN0cmluZywgVGFza1tdPik6IG51bWJlciB7XG4gICAgICAgIGNvbnN0IFRBR19XSURUSCA9IDIwMDtcbiAgICAgICAgY29uc3QgVEFHX0dBUCA9IDEyO1xuICAgICAgICBjb25zdCBQQURESU5HID0gNDg7XG5cbiAgICAgICAgY29uc3QgdGFnQ291bnQgPSB0YWdHcm91cHMuc2l6ZTtcbiAgICAgICAgY29uc3QgY29udGVudFdpZHRoID0gKHRhZ0NvdW50ICogVEFHX1dJRFRIKSArICgodGFnQ291bnQgLSAxKSAqIFRBR19HQVApO1xuICAgICAgICByZXR1cm4gY29udGVudFdpZHRoICsgUEFERElORztcbiAgICB9XG5cbiAgICByZW5kZXJGb2xkZXJTZWN0aW9uKGNvbnRhaW5lcjogSFRNTEVsZW1lbnQsIGZvbGRlck5hbWU6IHN0cmluZywgdGFnR3JvdXBzOiBNYXA8c3RyaW5nLCBUYXNrW10+LCB3aWR0aD86IG51bWJlciwgc3RhdHVzPzogc3RyaW5nKSB7XG4gICAgICAgIGNvbnN0IGZvbGRlclNlY3Rpb24gPSBjb250YWluZXIuY3JlYXRlRGl2KHsgY2xzOiAnZm9sZGVyLXNlY3Rpb24nIH0pO1xuICAgICAgICBmb2xkZXJTZWN0aW9uLnNldEF0dHJpYnV0ZSgnZGF0YS1mb2xkZXInLCBmb2xkZXJOYW1lKTtcbiAgICAgICAgXG4gICAgICAgIC8vIEFwcGx5IGNhbGN1bGF0ZWQgd2lkdGggaWYgcHJvdmlkZWRcbiAgICAgICAgaWYgKHdpZHRoICYmIHdpZHRoID4gMCkge1xuICAgICAgICAgICAgZm9sZGVyU2VjdGlvbi5zdHlsZS53aWR0aCA9IGAke3dpZHRofXB4YDtcbiAgICAgICAgICAgIGZvbGRlclNlY3Rpb24uc3R5bGUubWluV2lkdGggPSBgJHt3aWR0aH1weGA7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBGb2xkZXIgaGVhZGVyIHdpdGggZHJvcCBpbmRpY2F0b3IgYW5kICsgYnV0dG9uXG4gICAgICAgIGNvbnN0IGZvbGRlckhlYWRlciA9IGZvbGRlclNlY3Rpb24uY3JlYXRlRGl2KHsgY2xzOiAnZm9sZGVyLWhlYWRlcicgfSk7XG4gICAgICAgIGNvbnN0IGZvbGRlclRpdGxlQ29udGFpbmVyID0gZm9sZGVySGVhZGVyLmNyZWF0ZURpdih7IGNsczogJ2ZvbGRlci10aXRsZS1jb250YWluZXInIH0pO1xuICAgICAgICBmb2xkZXJUaXRsZUNvbnRhaW5lci5jcmVhdGVFbCgnaDQnLCB7IHRleHQ6IGZvbGRlck5hbWUsIGNsczogJ2ZvbGRlci10aXRsZScgfSk7XG4gICAgICAgIFxuICAgICAgICAvLyBBZGQgXCIrXCIgYnV0dG9uIG5leHQgdG8gZm9sZGVyIG5hbWVcbiAgICAgICAgY29uc3QgYWRkVGFnQnRuID0gZm9sZGVyVGl0bGVDb250YWluZXIuY3JlYXRlRWwoJ2J1dHRvbicsIHtcbiAgICAgICAgICAgIGNsczogJ2FkZC10YWctYnRuLWhlYWRlcicsXG4gICAgICAgICAgICB0ZXh0OiAnKycsXG4gICAgICAgICAgICBhdHRyOiB7IHRpdGxlOiAnQWRkIG5ldyB0YWcnIH1cbiAgICAgICAgfSk7XG4gICAgICAgIGFkZFRhZ0J0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgICAgIHRoaXMuc2hvd05ld1RhZ0RpYWxvZyhmb2xkZXJOYW1lKTtcbiAgICAgICAgfSk7XG4gICAgICAgIFxuICAgICAgICBjb25zdCB0b3RhbFRhc2tzID0gQXJyYXkuZnJvbSh0YWdHcm91cHMudmFsdWVzKCkpLnJlZHVjZSgoc3VtLCB0YXNrcykgPT4gc3VtICsgdGFza3MubGVuZ3RoLCAwKTtcbiAgICAgICAgZm9sZGVySGVhZGVyLmNyZWF0ZVNwYW4oeyB0ZXh0OiBgJHt0b3RhbFRhc2tzfWAsIGNsczogJ2ZvbGRlci1jb3VudCcgfSk7XG5cbiAgICAgICAgLy8gSG9yaXpvbnRhbCBjb250YWluZXIgZm9yIHRhZyBncm91cHNcbiAgICAgICAgY29uc3QgdGFnc0NvbnRhaW5lciA9IGZvbGRlclNlY3Rpb24uY3JlYXRlRGl2KHsgY2xzOiAndGFncy1jb250YWluZXInIH0pO1xuXG4gICAgICAgIC8vIFNvcnQgdGFncyBhbHBoYWJldGljYWxseVxuICAgICAgICBjb25zdCBzb3J0ZWRUYWdzID0gQXJyYXkuZnJvbSh0YWdHcm91cHMua2V5cygpKS5zb3J0KCk7XG5cbiAgICAgICAgLy8gUmVuZGVyIGVhY2ggdGFnIGdyb3VwXG4gICAgICAgIGZvciAoY29uc3QgdGFnIG9mIHNvcnRlZFRhZ3MpIHtcbiAgICAgICAgICAgIGNvbnN0IHRhc2tzID0gdGFnR3JvdXBzLmdldCh0YWcpITtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyVGFnR3JvdXAodGFnc0NvbnRhaW5lciwgZm9sZGVyTmFtZSwgdGFnLCB0YXNrcyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZW5kZXJUYWdHcm91cChjb250YWluZXI6IEhUTUxFbGVtZW50LCBmb2xkZXJOYW1lOiBzdHJpbmcsIHRhZzogc3RyaW5nLCB0YXNrczogVGFza1tdKSB7XG4gICAgICAgIGNvbnN0IHRhZ0dyb3VwID0gY29udGFpbmVyLmNyZWF0ZURpdih7IGNsczogJ3RhZy1ncm91cCcgfSk7XG4gICAgICAgIHRhZ0dyb3VwLnNldEF0dHJpYnV0ZSgnZGF0YS10YWcnLCB0YWcpO1xuXG4gICAgICAgIC8vIFRhZyBoZWFkZXJcbiAgICAgICAgY29uc3QgdGFnSGVhZGVyID0gdGFnR3JvdXAuY3JlYXRlRGl2KHsgY2xzOiAndGFnLWhlYWRlcicgfSk7XG4gICAgICAgIHRhZ0hlYWRlci5jcmVhdGVTcGFuKHsgdGV4dDogdGFnLCBjbHM6ICd0YWctZ3JvdXAtbmFtZScgfSk7XG4gICAgICAgIHRhZ0hlYWRlci5jcmVhdGVTcGFuKHsgdGV4dDogYCR7dGFza3MubGVuZ3RofWAsIGNsczogJ3RhZy1ncm91cC1jb3VudCcgfSk7XG5cbiAgICAgICAgLy8gVGFza3MgaW4gdGhpcyB0YWcgZ3JvdXAgd2l0aCBkcm9wIHpvbmUgZm9yIHRhZyBjaGFuZ2VzXG4gICAgICAgIGNvbnN0IHRhc2tzQ29udGFpbmVyID0gdGFnR3JvdXAuY3JlYXRlRGl2KHsgY2xzOiAndGFnLXRhc2tzJyB9KTtcbiAgICAgICAgdGhpcy5zZXR1cERyb3Bab25lKHRhc2tzQ29udGFpbmVyLCAndGFnJywgdGFnKTtcblxuICAgICAgICBmb3IgKGNvbnN0IHRhc2sgb2YgdGFza3MpIHtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyVGFza0NhcmQodGFza3NDb250YWluZXIsIHRhc2spO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gXCJOZXdcIiBidXR0b24gYXQgdGhlIGVuZCBvZiB0YWcgZ3JvdXBcbiAgICAgICAgY29uc3QgbmV3VGFza0J0biA9IHRhZ0dyb3VwLmNyZWF0ZUVsKCdidXR0b24nLCB7XG4gICAgICAgICAgICBjbHM6ICduZXctdGFzay1idG4nLFxuICAgICAgICAgICAgdGV4dDogJ05ldydcbiAgICAgICAgfSk7XG4gICAgICAgIG5ld1Rhc2tCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnNob3dOZXdUYXNrRGlhbG9nKGZvbGRlck5hbWUsIHRhZyk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIHNvcnRUYXNrcyh0YXNrczogVGFza1tdKSB7XG4gICAgICAgIGNvbnN0IHNvcnRCeSA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnNvcnRCeTtcbiAgICAgICAgY29uc3QgZGlyZWN0aW9uID0gdGhpcy5wbHVnaW4uc2V0dGluZ3Muc29ydERpcmVjdGlvbjtcbiAgICAgICAgY29uc3QgbXVsdGlwbGllciA9IGRpcmVjdGlvbiA9PT0gJ2FzYycgPyAxIDogLTE7XG5cbiAgICAgICAgdGFza3Muc29ydCgoYSwgYikgPT4ge1xuICAgICAgICAgICAgbGV0IGNvbXBhcmlzb24gPSAwO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKHNvcnRCeSkge1xuICAgICAgICAgICAgICAgIGNhc2UgJ3ByaW9yaXR5JzpcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcHJpb3JpdHlNYXAgPSB7IGhpZ2g6IDMsIG1lZGl1bTogMiwgbG93OiAxIH07XG4gICAgICAgICAgICAgICAgICAgIGNvbXBhcmlzb24gPSBwcmlvcml0eU1hcFthLnByaW9yaXR5XSAtIHByaW9yaXR5TWFwW2IucHJpb3JpdHldO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlICd0YWcnOlxuICAgICAgICAgICAgICAgICAgICBjb21wYXJpc29uID0gYS50YWcubG9jYWxlQ29tcGFyZShiLnRhZyk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGNhc2UgJ3RpdGxlJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGFyaXNvbiA9IGEudGl0bGUubG9jYWxlQ29tcGFyZShiLnRpdGxlKTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgY2FzZSAnZm9sZGVyJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGFyaXNvbiA9IGEuZm9sZGVyLmxvY2FsZUNvbXBhcmUoYi5mb2xkZXIpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGNvbXBhcmlzb24gKiBtdWx0aXBsaWVyO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICByZW5kZXJDb2x1bW4oYm9hcmQ6IEhUTUxFbGVtZW50LCBzdGF0dXM6IHN0cmluZywgdGFza3M6IFRhc2tbXSkge1xuICAgICAgICBjb25zdCBjb2x1bW4gPSBib2FyZC5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLWJvYXJkLWNvbHVtbicgfSk7XG4gICAgICAgIGNvbHVtbi5zZXRBdHRyaWJ1dGUoJ2RhdGEtc3RhdHVzJywgc3RhdHVzKTtcblxuICAgICAgICAvLyBDb2x1bW4gaGVhZGVyXG4gICAgICAgIGNvbnN0IGhlYWRlciA9IGNvbHVtbi5jcmVhdGVEaXYoeyBjbHM6ICd0YXNrLWNvbHVtbi1oZWFkZXInIH0pO1xuICAgICAgICBjb25zdCBzdGF0dXNMYWJlbCA9IHRoaXMuZ2V0U3RhdHVzTGFiZWwoc3RhdHVzKTtcbiAgICAgICAgaGVhZGVyLmNyZWF0ZUVsKCdoMycsIHsgdGV4dDogc3RhdHVzTGFiZWwsIGNsczogYHRhc2stY29sdW1uLXRpdGxlIHN0YXR1cy0ke3N0YXR1c31gIH0pO1xuICAgICAgICBoZWFkZXIuY3JlYXRlU3Bhbih7IHRleHQ6IGAke3Rhc2tzLmxlbmd0aH1gLCBjbHM6ICd0YXNrLWNvdW50JyB9KTtcblxuICAgICAgICAvLyBUYXNrcyBjb250YWluZXIgd2l0aCBkcm9wIHpvbmVcbiAgICAgICAgY29uc3QgdGFza3NDb250YWluZXIgPSBjb2x1bW4uY3JlYXRlRGl2KHsgY2xzOiAndGFzay1jb2x1bW4tdGFza3MnIH0pO1xuICAgICAgICB0aGlzLnNldHVwRHJvcFpvbmUodGFza3NDb250YWluZXIsICdzdGF0dXMnLCBzdGF0dXMpO1xuXG4gICAgICAgIC8vIFJlbmRlciB0YXNrc1xuICAgICAgICBmb3IgKGNvbnN0IHRhc2sgb2YgdGFza3MpIHtcbiAgICAgICAgICAgIHRoaXMucmVuZGVyVGFza0NhcmQodGFza3NDb250YWluZXIsIHRhc2spO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gU2V0dXAgZHJvcCB6b25lIGZvciBkcmFnIGFuZCBkcm9wXG4gICAgc2V0dXBEcm9wWm9uZShlbGVtZW50OiBIVE1MRWxlbWVudCwgdHlwZTogJ3N0YXR1cycgfCAndGFnJyB8ICdmb2xkZXInLCB2YWx1ZTogc3RyaW5nLCBmb2xkZXI/OiBURm9sZGVyKSB7XG4gICAgICAgIGVsZW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignZHJhZ292ZXInLCAoZSkgPT4ge1xuICAgICAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICAgICAgZWxlbWVudC5jbGFzc0xpc3QuYWRkKCdkcm9wLXRhcmdldCcpO1xuICAgICAgICB9KTtcblxuICAgICAgICBlbGVtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdsZWF2ZScsICgpID0+IHtcbiAgICAgICAgICAgIGVsZW1lbnQuY2xhc3NMaXN0LnJlbW92ZSgnZHJvcC10YXJnZXQnKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgZWxlbWVudC5hZGRFdmVudExpc3RlbmVyKCdkcm9wJywgYXN5bmMgKGUpID0+IHtcbiAgICAgICAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgICAgICAgIGVsZW1lbnQuY2xhc3NMaXN0LnJlbW92ZSgnZHJvcC10YXJnZXQnKTtcblxuICAgICAgICAgICAgY29uc3QgdGFza0lkID0gZS5kYXRhVHJhbnNmZXI/LmdldERhdGEoJ3RleHQvcGxhaW4nKTtcbiAgICAgICAgICAgIGlmICghdGFza0lkKSByZXR1cm47XG5cbiAgICAgICAgICAgIGNvbnN0IHRhc2sgPSB0aGlzLnRhc2tzLmZpbmQodCA9PiB0LmlkID09PSB0YXNrSWQpO1xuICAgICAgICAgICAgaWYgKCF0YXNrKSByZXR1cm47XG5cbiAgICAgICAgICAgIC8vIFByZXZlbnQgZHJvcHBpbmcgb24gc2FtZSBsb2NhdGlvblxuICAgICAgICAgICAgaWYgKHR5cGUgPT09ICdzdGF0dXMnICYmIHRhc2suc3RhdHVzID09PSB2YWx1ZSkgcmV0dXJuO1xuICAgICAgICAgICAgaWYgKHR5cGUgPT09ICd0YWcnICYmIHRhc2sudGFnID09PSB2YWx1ZSkgcmV0dXJuO1xuICAgICAgICAgICAgaWYgKHR5cGUgPT09ICdmb2xkZXInICYmIGZvbGRlciAmJiB0YXNrLmZpbGUucGFyZW50Py5wYXRoID09PSBmb2xkZXIucGF0aCkgcmV0dXJuO1xuXG4gICAgICAgICAgICAvLyBQZXJmb3JtIHRoZSBtb3ZlXG4gICAgICAgICAgICBpZiAodHlwZSA9PT0gJ3N0YXR1cycpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi51cGRhdGVUYXNrU3RhdHVzKHRhc2ssIHZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodHlwZSA9PT0gJ3RhZycpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi51cGRhdGVUYXNrKHRhc2ssIHZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodHlwZSA9PT0gJ2ZvbGRlcicgJiYgZm9sZGVyKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4ubW92ZVRhc2tUb0ZvbGRlcih0YXNrLCBmb2xkZXIpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aGlzLnJlZnJlc2goKTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmVuZGVyVGFza0NhcmQoY29udGFpbmVyOiBIVE1MRWxlbWVudCwgdGFzazogVGFzaykge1xuICAgICAgICBjb25zdCBjYXJkID0gY29udGFpbmVyLmNyZWF0ZURpdih7IGNsczogYHRhc2stY2FyZCBwcmlvcml0eS0ke3Rhc2sucHJpb3JpdHl9YCB9KTtcbiAgICAgICAgY2FyZC5zZXRBdHRyaWJ1dGUoJ2RhdGEtdGFzay1pZCcsIHRhc2suaWQpO1xuXG4gICAgICAgIC8vIFByaW9yaXR5IGluZGljYXRvclxuICAgICAgICBjb25zdCBwcmlvcml0eURvdCA9IGNhcmQuY3JlYXRlRGl2KHsgY2xzOiBgdGFzay1wcmlvcml0eSBwcmlvcml0eS0ke3Rhc2sucHJpb3JpdHl9YCB9KTtcbiAgICAgICAgcHJpb3JpdHlEb3QuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoZSkgPT4ge1xuICAgICAgICAgICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICAgICAgICAgIHRoaXMuc2hvd1ByaW9yaXR5TWVudSh0YXNrLCBwcmlvcml0eURvdCwgZSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIFRhc2sgdGl0bGVcbiAgICAgICAgY29uc3QgdGl0bGUgPSBjYXJkLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stdGl0bGUnIH0pO1xuICAgICAgICB0aXRsZS5jcmVhdGVFbCgnYScsIHtcbiAgICAgICAgICAgIHRleHQ6IHRhc2sudGl0bGUsXG4gICAgICAgICAgICBocmVmOiAnIycsXG4gICAgICAgICAgICBjbHM6ICd0YXNrLWxpbmsnXG4gICAgICAgIH0pLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKGUpID0+IHtcbiAgICAgICAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5vcGVuTGlua1RleHQodGFzay5maWxlLnBhdGgsICcnKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gVGFzayBtZXRhXG4gICAgICAgIGNvbnN0IG1ldGEgPSBjYXJkLmNyZWF0ZURpdih7IGNsczogJ3Rhc2stbWV0YScgfSk7XG5cbiAgICAgICAgLy8gVGFnXG4gICAgICAgIGlmICh0YXNrLnRhZyAmJiB0YXNrLnRhZyAhPT0gJ3VudGFnZ2VkJykge1xuICAgICAgICAgICAgbWV0YS5jcmVhdGVTcGFuKHsgdGV4dDogdGFzay50YWcsIGNsczogJ3Rhc2stdGFnJyB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEZvbGRlclxuICAgICAgICBtZXRhLmNyZWF0ZVNwYW4oeyB0ZXh0OiB0YXNrLmZvbGRlciwgY2xzOiAndGFzay1mb2xkZXInIH0pO1xuXG4gICAgICAgIC8vIFN0YXR1cyBjaGFuZ2Ugb24gY2FyZCBjbGlja1xuICAgICAgICBjYXJkLmFkZEV2ZW50TGlzdGVuZXIoJ2NvbnRleHRtZW51JywgKGUpID0+IHtcbiAgICAgICAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgICAgICAgIHRoaXMuc2hvd1N0YXR1c01lbnUodGFzaywgZSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIERyYWcgc3VwcG9ydCAoZGVza3RvcCBvbmx5IC0gSFRNTDUgZHJhZyBkb2Vzbid0IHdvcmsgd2VsbCBvbiBtb2JpbGUpXG4gICAgICAgIGNvbnN0IGlzTW9iaWxlID0gL2lQaG9uZXxpUGFkfGlQb2R8QW5kcm9pZC9pLnRlc3QobmF2aWdhdG9yLnVzZXJBZ2VudCk7XG4gICAgICAgIGlmICghaXNNb2JpbGUpIHtcbiAgICAgICAgICAgIGNhcmQuZHJhZ2dhYmxlID0gdHJ1ZTtcbiAgICAgICAgICAgIGNhcmQuYWRkRXZlbnRMaXN0ZW5lcignZHJhZ3N0YXJ0JywgKGUpID0+IHtcbiAgICAgICAgICAgICAgICBlLmRhdGFUcmFuc2Zlcj8uc2V0RGF0YSgndGV4dC9wbGFpbicsIHRhc2suaWQpO1xuICAgICAgICAgICAgICAgIGUuZGF0YVRyYW5zZmVyPy5zZXREYXRhKCd0YXNrL3RhZycsIHRhc2sudGFnKTtcbiAgICAgICAgICAgICAgICBlLmRhdGFUcmFuc2Zlcj8uc2V0RGF0YSgndGFzay9mb2xkZXInLCB0YXNrLmZvbGRlcik7XG4gICAgICAgICAgICAgICAgY2FyZC5jbGFzc0xpc3QuYWRkKCdkcmFnZ2luZycpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBjYXJkLmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdlbmQnLCAoKSA9PiB7XG4gICAgICAgICAgICAgICAgY2FyZC5jbGFzc0xpc3QucmVtb3ZlKCdkcmFnZ2luZycpO1xuICAgICAgICAgICAgICAgIC8vIFJlbW92ZSBhbGwgZHJvcC10YXJnZXQgaGlnaGxpZ2h0cyAoc2FmZWx5KVxuICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgZG9jdW1lbnQgIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZHJvcC10YXJnZXQnKS5mb3JFYWNoKGVsID0+IGVsLmNsYXNzTGlzdC5yZW1vdmUoJ2Ryb3AtdGFyZ2V0JykpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICAgICAgICAvLyBJZ25vcmUgZG9jdW1lbnQgZXJyb3JzIG9uIG1vYmlsZVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgc2hvd1ByaW9yaXR5TWVudSh0YXNrOiBUYXNrLCBlbGVtZW50OiBIVE1MRWxlbWVudCwgZXZ0OiBNb3VzZUV2ZW50KSB7XG4gICAgICAgIGNvbnN0IG1lbnUgPSBuZXcgTWVudSgpO1xuICAgICAgICBcbiAgICAgICAgY29uc3QgcHJpb3JpdGllcyA9IFsnaGlnaCcsICdtZWRpdW0nLCAnbG93J10gYXMgY29uc3Q7XG4gICAgICAgIGZvciAoY29uc3QgcHJpb3JpdHkgb2YgcHJpb3JpdGllcykge1xuICAgICAgICAgICAgbWVudS5hZGRJdGVtKChpdGVtKSA9PiB7XG4gICAgICAgICAgICAgICAgaXRlbS5zZXRUaXRsZShwcmlvcml0eS5jaGFyQXQoMCkudG9VcHBlckNhc2UoKSArIHByaW9yaXR5LnNsaWNlKDEpKVxuICAgICAgICAgICAgICAgICAgICAuc2V0SWNvbih0YXNrLnByaW9yaXR5ID09PSBwcmlvcml0eSA/ICdjaGVjaycgOiAnJylcbiAgICAgICAgICAgICAgICAgICAgLm9uQ2xpY2soYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4udXBkYXRlVGFza1ByaW9yaXR5KHRhc2ssIHByaW9yaXR5KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMucmVmcmVzaCgpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgbWVudS5zaG93QXRNb3VzZUV2ZW50KGV2dCk7XG4gICAgfVxuXG4gICAgc2hvd1N0YXR1c01lbnUodGFzazogVGFzaywgZXZ0OiBNb3VzZUV2ZW50KSB7XG4gICAgICAgIGNvbnN0IG1lbnUgPSBuZXcgTWVudSgpO1xuICAgICAgICBcbiAgICAgICAgZm9yIChjb25zdCBzdGF0dXMgb2YgdGhpcy5wbHVnaW4uc2V0dGluZ3Muc3RhdHVzT3JkZXIpIHtcbiAgICAgICAgICAgIG1lbnUuYWRkSXRlbSgoaXRlbSkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IGxhYmVsID0gdGhpcy5nZXRTdGF0dXNMYWJlbChzdGF0dXMpO1xuICAgICAgICAgICAgICAgIGl0ZW0uc2V0VGl0bGUobGFiZWwpXG4gICAgICAgICAgICAgICAgICAgIC5zZXRJY29uKHRhc2suc3RhdHVzID09PSBzdGF0dXMgPyAnY2hlY2snIDogJycpXG4gICAgICAgICAgICAgICAgICAgIC5vbkNsaWNrKGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnVwZGF0ZVRhc2tTdGF0dXModGFzaywgc3RhdHVzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMucmVmcmVzaCgpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgbWVudS5zaG93QXRNb3VzZUV2ZW50KGV2dCk7XG4gICAgfVxuXG4gICAgZ2V0U3RhdHVzTGFiZWwoc3RhdHVzOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgICAgICBjb25zdCBsYWJlbHM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgICAgICAgICAndG9kbyc6ICdUbyBEbycsXG4gICAgICAgICAgICAnaW4tcHJvZ3Jlc3MnOiAnSW4gUHJvZ3Jlc3MnLFxuICAgICAgICAgICAgJ2RvbmUnOiAnRG9uZScsXG4gICAgICAgICAgICAnYXJjaGl2ZSc6ICdBcmNoaXZlJ1xuICAgICAgICB9O1xuICAgICAgICByZXR1cm4gbGFiZWxzW3N0YXR1c10gfHwgc3RhdHVzLmNoYXJBdCgwKS50b1VwcGVyQ2FzZSgpICsgc3RhdHVzLnNsaWNlKDEpO1xuICAgIH1cblxuICAgIC8vIFNob3cgZGlhbG9nIHRvIGNyZWF0ZSBhIG5ldyB0YXNrIGluIGEgc3BlY2lmaWMgZm9sZGVyIGFuZCB0YWdcbiAgICBzaG93TmV3VGFza0RpYWxvZyhmb2xkZXJOYW1lOiBzdHJpbmcsIHRhZzogc3RyaW5nKSB7XG4gICAgICAgIGNvbnN0IG1vZGFsID0gbmV3IE5ld1Rhc2tNb2RhbCh0aGlzLmFwcCwgZm9sZGVyTmFtZSwgdGFnLCAodGl0bGUsIGZvbGRlciwgdGFza1RhZywgcHJpb3JpdHkpID0+IHtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLmNyZWF0ZU5ld1Rhc2sodGl0bGUsIGZvbGRlciwgdGFza1RhZywgcHJpb3JpdHkpO1xuICAgICAgICB9KTtcbiAgICAgICAgbW9kYWwub3BlbigpO1xuICAgIH1cblxuICAgIC8vIFNob3cgZGlhbG9nIHRvIGNyZWF0ZSBhIG5ldyB0YWcgd2l0aCBhIFRPRE8gaXRlbVxuICAgIHNob3dOZXdUYWdEaWFsb2coZm9sZGVyTmFtZTogc3RyaW5nKSB7XG4gICAgICAgIGNvbnN0IG1vZGFsID0gbmV3IE5ld1RhZ01vZGFsKHRoaXMuYXBwLCBmb2xkZXJOYW1lLCAodGFnTmFtZSwgdGl0bGUsIHByaW9yaXR5KSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5jcmVhdGVOZXdUYXNrKHRpdGxlLCBmb2xkZXJOYW1lLCB0YWdOYW1lLCBwcmlvcml0eSk7XG4gICAgICAgIH0pO1xuICAgICAgICBtb2RhbC5vcGVuKCk7XG4gICAgfVxufVxuXG4vLyBNb2RhbCBmb3IgY3JlYXRpbmcgYSBuZXcgdGFza1xuY2xhc3MgTmV3VGFza01vZGFsIGV4dGVuZHMgTW9kYWwge1xuICAgIGZvbGRlcjogc3RyaW5nO1xuICAgIHRhZzogc3RyaW5nO1xuICAgIG9uU3VibWl0OiAodGl0bGU6IHN0cmluZywgZm9sZGVyOiBzdHJpbmcsIHRhZzogc3RyaW5nLCBwcmlvcml0eTogc3RyaW5nKSA9PiB2b2lkO1xuXG4gICAgY29uc3RydWN0b3IoYXBwOiBBcHAsIGZvbGRlcjogc3RyaW5nLCB0YWc6IHN0cmluZywgb25TdWJtaXQ6ICh0aXRsZTogc3RyaW5nLCBmb2xkZXI6IHN0cmluZywgdGFnOiBzdHJpbmcsIHByaW9yaXR5OiBzdHJpbmcpID0+IHZvaWQpIHtcbiAgICAgICAgc3VwZXIoYXBwKTtcbiAgICAgICAgdGhpcy5mb2xkZXIgPSBmb2xkZXI7XG4gICAgICAgIHRoaXMudGFnID0gdGFnO1xuICAgICAgICB0aGlzLm9uU3VibWl0ID0gb25TdWJtaXQ7XG4gICAgfVxuXG4gICAgb25PcGVuKCkge1xuICAgICAgICBjb25zdCB7IGNvbnRlbnRFbCB9ID0gdGhpcztcbiAgICAgICAgY29udGVudEVsLmNyZWF0ZUVsKCdoMicsIHsgdGV4dDogJ0NyZWF0ZSBOZXcgVGFzaycgfSk7XG5cbiAgICAgICAgLy8gVGl0bGUgaW5wdXRcbiAgICAgICAgY29udGVudEVsLmNyZWF0ZUVsKCdsYWJlbCcsIHsgdGV4dDogJ1Rhc2sgVGl0bGU6JyB9KTtcbiAgICAgICAgY29uc3QgdGl0bGVJbnB1dCA9IGNvbnRlbnRFbC5jcmVhdGVFbCgnaW5wdXQnLCB7XG4gICAgICAgICAgICB0eXBlOiAndGV4dCcsXG4gICAgICAgICAgICBwbGFjZWhvbGRlcjogJ0VudGVyIHRhc2sgdGl0bGUuLi4nXG4gICAgICAgIH0pO1xuICAgICAgICB0aXRsZUlucHV0LnN0eWxlLndpZHRoID0gJzEwMCUnO1xuICAgICAgICB0aXRsZUlucHV0LnN0eWxlLm1hcmdpbkJvdHRvbSA9ICcxNnB4JztcblxuICAgICAgICAvLyBGb2xkZXIgaW5mb1xuICAgICAgICBjb250ZW50RWwuY3JlYXRlRWwoJ2xhYmVsJywgeyB0ZXh0OiAnRm9sZGVyOicgfSk7XG4gICAgICAgIGNvbnRlbnRFbC5jcmVhdGVFbCgnZGl2JywgeyB0ZXh0OiB0aGlzLmZvbGRlciwgY2xzOiAnbmV3LXRhc2staW5mbycgfSk7XG5cbiAgICAgICAgLy8gVGFnIGluZm9cbiAgICAgICAgY29udGVudEVsLmNyZWF0ZUVsKCdsYWJlbCcsIHsgdGV4dDogJ1RhZzonIH0pO1xuICAgICAgICBjb250ZW50RWwuY3JlYXRlRWwoJ2RpdicsIHsgdGV4dDogdGhpcy50YWcsIGNsczogJ25ldy10YXNrLWluZm8nIH0pO1xuXG4gICAgICAgIC8vIFByaW9yaXR5IHNlbGVjdGlvblxuICAgICAgICBjb250ZW50RWwuY3JlYXRlRWwoJ2xhYmVsJywgeyB0ZXh0OiAnUHJpb3JpdHk6JyB9KTtcbiAgICAgICAgY29uc3QgcHJpb3JpdHlTZWxlY3QgPSBjb250ZW50RWwuY3JlYXRlRWwoJ3NlbGVjdCcpO1xuICAgICAgICBwcmlvcml0eVNlbGVjdC5zdHlsZS53aWR0aCA9ICcxMDAlJztcbiAgICAgICAgcHJpb3JpdHlTZWxlY3Quc3R5bGUubWFyZ2luQm90dG9tID0gJzE2cHgnO1xuICAgICAgICBbJ2hpZ2gnLCAnbWVkaXVtJywgJ2xvdyddLmZvckVhY2gocCA9PiB7XG4gICAgICAgICAgICBjb25zdCBvcHRpb24gPSBwcmlvcml0eVNlbGVjdC5jcmVhdGVFbCgnb3B0aW9uJywgeyB0ZXh0OiBwLCB2YWx1ZTogcCB9KTtcbiAgICAgICAgICAgIGlmIChwID09PSAnbWVkaXVtJykgb3B0aW9uLnNlbGVjdGVkID0gdHJ1ZTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gQnV0dG9uc1xuICAgICAgICBjb25zdCBidXR0b25Db250YWluZXIgPSBjb250ZW50RWwuY3JlYXRlRGl2KHsgY2xzOiAnbW9kYWwtYnV0dG9uLWNvbnRhaW5lcicgfSk7XG5cbiAgICAgICAgY29uc3Qgc3VibWl0QnRuID0gYnV0dG9uQ29udGFpbmVyLmNyZWF0ZUVsKCdidXR0b24nLCB7XG4gICAgICAgICAgICB0ZXh0OiAnQ3JlYXRlJyxcbiAgICAgICAgICAgIGNsczogJ21vZC1jdGEnXG4gICAgICAgIH0pO1xuICAgICAgICBzdWJtaXRCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCB0aXRsZSA9IHRpdGxlSW5wdXQudmFsdWUudHJpbSgpO1xuICAgICAgICAgICAgaWYgKHRpdGxlKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5vblN1Ym1pdCh0aXRsZSwgdGhpcy5mb2xkZXIsIHRoaXMudGFnLCBwcmlvcml0eVNlbGVjdC52YWx1ZSk7XG4gICAgICAgICAgICAgICAgdGhpcy5jbG9zZSgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBjb25zdCBjYW5jZWxCdG4gPSBidXR0b25Db250YWluZXIuY3JlYXRlRWwoJ2J1dHRvbicsIHsgdGV4dDogJ0NhbmNlbCcgfSk7XG4gICAgICAgIGNhbmNlbEJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHRoaXMuY2xvc2UoKSk7XG5cbiAgICAgICAgLy8gRm9jdXMgdGl0bGUgaW5wdXRcbiAgICAgICAgdGl0bGVJbnB1dC5mb2N1cygpO1xuICAgIH1cblxuICAgIG9uQ2xvc2UoKSB7XG4gICAgICAgIGNvbnN0IHsgY29udGVudEVsIH0gPSB0aGlzO1xuICAgICAgICBjb250ZW50RWwuZW1wdHkoKTtcbiAgICB9XG59XG5cbi8vIE1vZGFsIGZvciBjcmVhdGluZyBhIG5ldyB0YWdcbmNsYXNzIE5ld1RhZ01vZGFsIGV4dGVuZHMgTW9kYWwge1xuICAgIGZvbGRlcjogc3RyaW5nO1xuICAgIG9uU3VibWl0OiAodGFnTmFtZTogc3RyaW5nLCB0aXRsZTogc3RyaW5nLCBwcmlvcml0eTogc3RyaW5nKSA9PiB2b2lkO1xuXG4gICAgY29uc3RydWN0b3IoYXBwOiBBcHAsIGZvbGRlcjogc3RyaW5nLCBvblN1Ym1pdDogKHRhZ05hbWU6IHN0cmluZywgdGl0bGU6IHN0cmluZywgcHJpb3JpdHk6IHN0cmluZykgPT4gdm9pZCkge1xuICAgICAgICBzdXBlcihhcHApO1xuICAgICAgICB0aGlzLmZvbGRlciA9IGZvbGRlcjtcbiAgICAgICAgdGhpcy5vblN1Ym1pdCA9IG9uU3VibWl0O1xuICAgIH1cblxuICAgIG9uT3BlbigpIHtcbiAgICAgICAgY29uc3QgeyBjb250ZW50RWwgfSA9IHRoaXM7XG4gICAgICAgIGNvbnRlbnRFbC5jcmVhdGVFbCgnaDInLCB7IHRleHQ6ICdDcmVhdGUgTmV3IFRhZyB3aXRoIFRhc2snIH0pO1xuXG4gICAgICAgIC8vIFRhZyBuYW1lIGlucHV0XG4gICAgICAgIGNvbnRlbnRFbC5jcmVhdGVFbCgnbGFiZWwnLCB7IHRleHQ6ICdUYWcgTmFtZTonIH0pO1xuICAgICAgICBjb25zdCB0YWdJbnB1dCA9IGNvbnRlbnRFbC5jcmVhdGVFbCgnaW5wdXQnLCB7XG4gICAgICAgICAgICB0eXBlOiAndGV4dCcsXG4gICAgICAgICAgICBwbGFjZWhvbGRlcjogJ0VudGVyIG5ldyB0YWcgbmFtZS4uLidcbiAgICAgICAgfSk7XG4gICAgICAgIHRhZ0lucHV0LnN0eWxlLndpZHRoID0gJzEwMCUnO1xuICAgICAgICB0YWdJbnB1dC5zdHlsZS5tYXJnaW5Cb3R0b20gPSAnMTZweCc7XG5cbiAgICAgICAgLy8gVGFzayB0aXRsZSBpbnB1dFxuICAgICAgICBjb250ZW50RWwuY3JlYXRlRWwoJ2xhYmVsJywgeyB0ZXh0OiAnVGFzayBUaXRsZTonIH0pO1xuICAgICAgICBjb25zdCB0aXRsZUlucHV0ID0gY29udGVudEVsLmNyZWF0ZUVsKCdpbnB1dCcsIHtcbiAgICAgICAgICAgIHR5cGU6ICd0ZXh0JyxcbiAgICAgICAgICAgIHBsYWNlaG9sZGVyOiAnRW50ZXIgdGFzayB0aXRsZS4uLidcbiAgICAgICAgfSk7XG4gICAgICAgIHRpdGxlSW5wdXQuc3R5bGUud2lkdGggPSAnMTAwJSc7XG4gICAgICAgIHRpdGxlSW5wdXQuc3R5bGUubWFyZ2luQm90dG9tID0gJzE2cHgnO1xuXG4gICAgICAgIC8vIEZvbGRlciBpbmZvXG4gICAgICAgIGNvbnRlbnRFbC5jcmVhdGVFbCgnbGFiZWwnLCB7IHRleHQ6ICdGb2xkZXI6JyB9KTtcbiAgICAgICAgY29udGVudEVsLmNyZWF0ZUVsKCdkaXYnLCB7IHRleHQ6IHRoaXMuZm9sZGVyLCBjbHM6ICduZXctdGFzay1pbmZvJyB9KTtcblxuICAgICAgICAvLyBQcmlvcml0eSBzZWxlY3Rpb25cbiAgICAgICAgY29udGVudEVsLmNyZWF0ZUVsKCdsYWJlbCcsIHsgdGV4dDogJ1ByaW9yaXR5OicgfSk7XG4gICAgICAgIGNvbnN0IHByaW9yaXR5U2VsZWN0ID0gY29udGVudEVsLmNyZWF0ZUVsKCdzZWxlY3QnKTtcbiAgICAgICAgcHJpb3JpdHlTZWxlY3Quc3R5bGUud2lkdGggPSAnMTAwJSc7XG4gICAgICAgIHByaW9yaXR5U2VsZWN0LnN0eWxlLm1hcmdpbkJvdHRvbSA9ICcxNnB4JztcbiAgICAgICAgWydoaWdoJywgJ21lZGl1bScsICdsb3cnXS5mb3JFYWNoKHAgPT4ge1xuICAgICAgICAgICAgY29uc3Qgb3B0aW9uID0gcHJpb3JpdHlTZWxlY3QuY3JlYXRlRWwoJ29wdGlvbicsIHsgdGV4dDogcCwgdmFsdWU6IHAgfSk7XG4gICAgICAgICAgICBpZiAocCA9PT0gJ21lZGl1bScpIG9wdGlvbi5zZWxlY3RlZCA9IHRydWU7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIEJ1dHRvbnNcbiAgICAgICAgY29uc3QgYnV0dG9uQ29udGFpbmVyID0gY29udGVudEVsLmNyZWF0ZURpdih7IGNsczogJ21vZGFsLWJ1dHRvbi1jb250YWluZXInIH0pO1xuXG4gICAgICAgIGNvbnN0IHN1Ym1pdEJ0biA9IGJ1dHRvbkNvbnRhaW5lci5jcmVhdGVFbCgnYnV0dG9uJywge1xuICAgICAgICAgICAgdGV4dDogJ0NyZWF0ZScsXG4gICAgICAgICAgICBjbHM6ICdtb2QtY3RhJ1xuICAgICAgICB9KTtcbiAgICAgICAgc3VibWl0QnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICAgICAgY29uc3QgdGFnTmFtZSA9IHRhZ0lucHV0LnZhbHVlLnRyaW0oKS50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1xccysvZywgJy0nKTtcbiAgICAgICAgICAgIGNvbnN0IHRpdGxlID0gdGl0bGVJbnB1dC52YWx1ZS50cmltKCk7XG4gICAgICAgICAgICBpZiAodGFnTmFtZSAmJiB0aXRsZSkge1xuICAgICAgICAgICAgICAgIHRoaXMub25TdWJtaXQodGFnTmFtZSwgdGl0bGUsIHByaW9yaXR5U2VsZWN0LnZhbHVlKTtcbiAgICAgICAgICAgICAgICB0aGlzLmNsb3NlKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGNvbnN0IGNhbmNlbEJ0biA9IGJ1dHRvbkNvbnRhaW5lci5jcmVhdGVFbCgnYnV0dG9uJywgeyB0ZXh0OiAnQ2FuY2VsJyB9KTtcbiAgICAgICAgY2FuY2VsQnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdGhpcy5jbG9zZSgpKTtcblxuICAgICAgICAvLyBGb2N1cyB0YWcgaW5wdXRcbiAgICAgICAgdGFnSW5wdXQuZm9jdXMoKTtcbiAgICB9XG5cbiAgICBvbkNsb3NlKCkge1xuICAgICAgICBjb25zdCB7IGNvbnRlbnRFbCB9ID0gdGhpcztcbiAgICAgICAgY29udGVudEVsLmVtcHR5KCk7XG4gICAgfVxufVxuXG4vLyBTZXR0aW5ncyBUYWJcbmNsYXNzIFRhc2tCb2FyZFNldHRpbmdUYWIgZXh0ZW5kcyBQbHVnaW5TZXR0aW5nVGFiIHtcbiAgICBwbHVnaW46IFRhc2tCb2FyZFBsdWdpbjtcblxuICAgIGNvbnN0cnVjdG9yKGFwcDogQXBwLCBwbHVnaW46IFRhc2tCb2FyZFBsdWdpbikge1xuICAgICAgICBzdXBlcihhcHAsIHBsdWdpbik7XG4gICAgICAgIHRoaXMucGx1Z2luID0gcGx1Z2luO1xuICAgIH1cblxuICAgIGRpc3BsYXkoKTogdm9pZCB7XG4gICAgICAgIGNvbnN0IHsgY29udGFpbmVyRWwgfSA9IHRoaXM7XG4gICAgICAgIGNvbnRhaW5lckVsLmVtcHR5KCk7XG5cbiAgICAgICAgY29udGFpbmVyRWwuY3JlYXRlRWwoJ2gyJywgeyB0ZXh0OiAnVGFzayBCb2FyZCBTZXR0aW5ncycgfSk7XG5cbiAgICAgICAgLy8gVGFzayBmb2xkZXJzXG4gICAgICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgICAgICAgLnNldE5hbWUoJ1Rhc2sgZm9sZGVyIG5hbWVzJylcbiAgICAgICAgICAgIC5zZXREZXNjKCdOYW1lcyBvZiBmb2xkZXJzIHRoYXQgY29udGFpbiB0YXNrcyAoY29tbWEtc2VwYXJhdGVkKS4gV2lsbCBzZWFyY2ggaW4gc3ViZm9sZGVycyByZWN1cnNpdmVseS4nKVxuICAgICAgICAgICAgLmFkZFRleHQodGV4dCA9PiB0ZXh0XG4gICAgICAgICAgICAgICAgLnNldFBsYWNlaG9sZGVyKCd0YXNrcywgdG9kbywgaXNzdWVzJylcbiAgICAgICAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MudGFza0ZvbGRlcnMuam9pbignLCAnKSlcbiAgICAgICAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLnRhc2tGb2xkZXJzID0gdmFsdWVcbiAgICAgICAgICAgICAgICAgICAgICAgIC5zcGxpdCgnLCcpXG4gICAgICAgICAgICAgICAgICAgICAgICAubWFwKHMgPT4gcy50cmltKCkpXG4gICAgICAgICAgICAgICAgICAgICAgICAuZmlsdGVyKHMgPT4gcy5sZW5ndGggPiAwKTtcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgICAgICAgfSkpO1xuXG4gICAgICAgIC8vIFN0YXR1cyBvcmRlclxuICAgICAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgICAgICAgIC5zZXROYW1lKCdTdGF0dXMgY29sdW1ucycpXG4gICAgICAgICAgICAuc2V0RGVzYygnT3JkZXIgb2Ygc3RhdHVzIGNvbHVtbnMgKGNvbW1hLXNlcGFyYXRlZCknKVxuICAgICAgICAgICAgLmFkZFRleHQodGV4dCA9PiB0ZXh0XG4gICAgICAgICAgICAgICAgLnNldFBsYWNlaG9sZGVyKCd0b2RvLCBpbi1wcm9ncmVzcywgZG9uZSwgYXJjaGl2ZScpXG4gICAgICAgICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLnN0YXR1c09yZGVyLmpvaW4oJywgJykpXG4gICAgICAgICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zdGF0dXNPcmRlciA9IHZhbHVlXG4gICAgICAgICAgICAgICAgICAgICAgICAuc3BsaXQoJywnKVxuICAgICAgICAgICAgICAgICAgICAgICAgLm1hcChzID0+IHMudHJpbSgpKVxuICAgICAgICAgICAgICAgICAgICAgICAgLmZpbHRlcihzID0+IHMubGVuZ3RoID4gMCk7XG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgICAgIH0pKTtcblxuICAgICAgICAvLyBEZWZhdWx0IHN0YXR1c1xuICAgICAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgICAgICAgIC5zZXROYW1lKCdEZWZhdWx0IHN0YXR1cycpXG4gICAgICAgICAgICAuc2V0RGVzYygnRGVmYXVsdCBzdGF0dXMgZm9yIHRhc2tzIHdpdGhvdXQgZnJvbnRtYXR0ZXInKVxuICAgICAgICAgICAgLmFkZFRleHQodGV4dCA9PiB0ZXh0XG4gICAgICAgICAgICAgICAgLnNldFBsYWNlaG9sZGVyKCd0b2RvJylcbiAgICAgICAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuZGVmYXVsdFN0YXR1cylcbiAgICAgICAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLmRlZmF1bHRTdGF0dXMgPSB2YWx1ZS50cmltKCkgfHwgJ3RvZG8nO1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICAgICAgICB9KSk7XG4gICAgfVxufVxuIl19