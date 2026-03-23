import {
    App,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    TFolder,
    ItemView,
    WorkspaceLeaf,
    Notice,
    Menu,
    TextComponent,
    DropdownComponent,
    ButtonComponent,
    MarkdownRenderer,
    Component,
    Modal
} from 'obsidian';

// Task interface
interface Task {
    id: string;
    file: TFile;
    title: string;
    status: string;
    tag: string;
    priority: 'high' | 'medium' | 'low';
    content: string;
    folder: string;
}

// Plugin settings
interface TaskBoardSettings {
    taskFolders: string[];
    statusOrder: string[];
    defaultStatus: string;
    sortBy: 'priority' | 'tag' | 'title' | 'folder';
    sortDirection: 'asc' | 'desc';
    organizeByTag: boolean;
    hiddenStatuses: string[];
}

const DEFAULT_SETTINGS: TaskBoardSettings = {
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
export default class TaskBoardPlugin extends Plugin {
    settings: TaskBoardSettings;

    async onload() {
        await this.loadSettings();

        // Register the custom view
        this.registerView(
            VIEW_TYPE_TASK_BOARD,
            (leaf) => new TaskBoardView(leaf, this)
        );

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
            checkCallback: (checking: boolean) => {
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
        this.registerEvent(
            this.app.vault.on('create', () => this.refreshView())
        );
        this.registerEvent(
            this.app.vault.on('delete', () => this.refreshView())
        );
        this.registerEvent(
            this.app.vault.on('rename', () => this.refreshView())
        );
        this.registerEvent(
            this.app.metadataCache.on('changed', () => this.refreshView())
        );
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

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_TASK_BOARD);

        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            // Create in main view area instead of sidebar
            leaf = workspace.getLeaf('tab');
            await leaf.setViewState({ type: VIEW_TYPE_TASK_BOARD, active: true });
        }

        workspace.revealLeaf(leaf);
    }

    refreshView() {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASK_BOARD);
        for (const leaf of leaves) {
            const view = leaf.view as TaskBoardView;
            view.refresh();
        }
    }

    // Recursively collect all markdown files from a folder and its subfolders
    private collectMarkdownFiles(folder: TFolder): TFile[] {
        const files: TFile[] = [];
        
        for (const child of folder.children) {
            if (child instanceof TFile && child.extension === 'md') {
                files.push(child);
            } else if (child instanceof TFolder) {
                // Recursively get files from subfolders
                files.push(...this.collectMarkdownFiles(child));
            }
        }
        
        return files;
    }

    // Scan all task folders and return tasks (including subfolders)
    async scanTasks(): Promise<Task[]> {
        const tasks: Task[] = [];
        const vault = this.app.vault;

        // Get all folders in vault
        const allFolders = vault.getAllLoadedFiles()
            .filter(f => f instanceof TFolder) as TFolder[];

        // Find task folders (exact matches or folders ending with /tasks, etc.)
        const taskFolders: TFolder[] = [];
        for (const folder of allFolders) {
            if (this.settings.taskFolders.some(tf => 
                folder.path === tf || 
                folder.path.endsWith('/' + tf) ||
                folder.name === tf
            )) {
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
    async parseTaskFile(file: TFile, folder: TFolder): Promise<Task | null> {
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
                    } else {
                        inFrontmatter = false;
                        frontmatterEnded = true;
                        continue;
                    }
                }
                
                // Skip lines inside frontmatter
                if (inFrontmatter) continue;
                
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
                priority: (frontmatter?.priority || 'medium') as 'high' | 'medium' | 'low',
                content: content,
                folder: parentFolder
            };
        } catch (error) {
            console.error('Error parsing task file:', file.path, error);
            return null;
        }
    }

    // Update task status
    async updateTaskStatus(task: Task, newStatus: string) {
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
                    newFrontmatter = newFrontmatter.replace(
                        /status:\s*\w+/,
                        `status: ${newStatus}`
                    );
                    // If status doesn't exist, add it
                    if (!newFrontmatter.includes('status:')) {
                        newFrontmatter = `status: ${newStatus}\n${newFrontmatter}`;
                    }

                    const newContent = content.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
                    await this.app.vault.modify(task.file, newContent);
                }
            } else {
                // Add frontmatter if it doesn't exist
                const newFrontmatter = `---\nstatus: ${newStatus}\ntag: ${task.tag}\npriority: ${task.priority}\n---\n\n`;
                await this.app.vault.modify(task.file, newFrontmatter + task.content);
            }

            task.status = newStatus;
            new Notice(`Task moved to ${newStatus}`);
        } catch (error) {
            console.error('Error updating task status:', error);
            new Notice('Failed to update task status');
        }
    }

    // Update task priority
    async updateTaskPriority(task: Task, newPriority: string) {
        try {
            const content = await this.app.vault.read(task.file);
            const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
            const match = content.match(frontmatterRegex);

            if (match) {
                let newFrontmatter = match[1];
                newFrontmatter = newFrontmatter.replace(
                    /priority:\s*\w+/,
                    `priority: ${newPriority}`
                );
                if (!newFrontmatter.includes('priority:')) {
                    newFrontmatter = newFrontmatter.replace(
                        /(status:[^\n]*)/,
                        `$1\npriority: ${newPriority}`
                    );
                }

                const newContent = content.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
                await this.app.vault.modify(task.file, newContent);
                task.priority = newPriority as 'high' | 'medium' | 'low';
            }
        } catch (error) {
            console.error('Error updating task priority:', error);
        }
    }

    // Update task tag
    async updateTask(task: Task, newTag: string) {
        try {
            const content = await this.app.vault.read(task.file);
            const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
            const match = content.match(frontmatterRegex);

            if (match) {
                let newFrontmatter = match[1];
                newFrontmatter = newFrontmatter.replace(
                    /tag:\s*\S+/,
                    `tag: ${newTag}`
                );
                if (!newFrontmatter.includes('tag:')) {
                    newFrontmatter = newFrontmatter.replace(
                        /(status:[^\n]*)/,
                        `$1\ntag: ${newTag}`
                    );
                }

                const newContent = content.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
                await this.app.vault.modify(task.file, newContent);
                task.tag = newTag;
                new Notice(`Task tag changed to ${newTag}`);
            }
        } catch (error) {
            console.error('Error updating task tag:', error);
            new Notice('Failed to update task tag');
        }
    }

    // Move task to different folder
    async moveTaskToFolder(task: Task, targetFolder: TFolder) {
        try {
            const newPath = `${targetFolder.path}/${task.file.name}`;
            await this.app.vault.rename(task.file, newPath);
            new Notice(`Task moved to ${targetFolder.name}`);
        } catch (error) {
            console.error('Error moving task:', error);
            new Notice('Failed to move task');
        }
    }

    // Create a new task
    async createNewTask(title: string, folderName: string, tag: string, priority: string = 'medium') {
        try {
            // Find the base tasks folder
            const vault = this.app.vault;
            const allFolders = vault.getAllLoadedFiles()
                .filter(f => f instanceof TFolder) as TFolder[];
            
            let targetFolder: TFolder | null = null;
            
            // Find the tasks folder that contains this folder
            for (const folder of allFolders) {
                if (folder.name === folderName || folder.path.includes(`/${folderName}/`) || folder.path.endsWith(`/${folderName}`)) {
                    // Check if this is a task folder
                    const isTaskFolder = this.settings.taskFolders.some(tf => 
                        folder.path === tf || 
                        folder.path.endsWith('/' + tf) ||
                        folder.name === tf
                    );
                    if (isTaskFolder || folder.path.includes('/tasks/')) {
                        targetFolder = folder;
                        break;
                    }
                }
            }
            
            // Fallback: find any tasks folder
            if (!targetFolder) {
                for (const folder of allFolders) {
                    if (this.settings.taskFolders.some(tf => 
                        folder.name === tf || folder.path.endsWith('/' + tf)
                    )) {
                        targetFolder = folder;
                        break;
                    }
                }
            }

            if (!targetFolder) {
                new Notice('Could not find tasks folder');
                return;
            }

            // Create folder for tag if it doesn't exist
            const tagFolderPath = `${targetFolder.path}/${tag}`;
            let tagFolder = vault.getAbstractFileByPath(tagFolderPath);
            if (!tagFolder) {
                await vault.createFolder(tagFolderPath);
                tagFolder = vault.getAbstractFileByPath(tagFolderPath);
            }

            if (!(tagFolder instanceof TFolder)) {
                new Notice('Error creating tag folder');
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
            new Notice(`Task created: ${title}`);
            this.refreshView();

            // Open the new file
            const newFile = vault.getAbstractFileByPath(finalPath);
            if (newFile instanceof TFile) {
                this.app.workspace.openLinkText(newFile.path, '');
            }
        } catch (error) {
            console.error('Error creating task:', error);
            new Notice('Failed to create task');
        }
    }

    // Organize all tasks by tag - moves files into subfolders named after their tags
    async organizeTasksByTag() {
        const tasks = await this.scanTasks();
        const tasksByTag = new Map<string, Task[]>();

        // Group tasks by tag
        for (const task of tasks) {
            const tag = task.tag || 'untagged';
            if (!tasksByTag.has(tag)) {
                tasksByTag.set(tag, []);
            }
            tasksByTag.get(tag)!.push(task);
        }

        let movedCount = 0;
        const vault = this.app.vault;

        // Process each tag group
        for (const [tag, tagTasks] of tasksByTag) {
            for (const task of tagTasks) {
                // Skip if already in correct folder
                const currentFolder = task.file.parent?.name;
                if (currentFolder === tag) continue;

                // Determine destination folder
                const baseFolder = this.findBaseTaskFolder(task.file);
                if (!baseFolder) continue;

                const targetFolderPath = `${baseFolder.path}/${tag}`;
                
                try {
                    // Create target folder if it doesn't exist
                    let targetFolder = vault.getAbstractFileByPath(targetFolderPath);
                    if (!targetFolder) {
                        await vault.createFolder(targetFolderPath);
                        targetFolder = vault.getAbstractFileByPath(targetFolderPath);
                    }

                    if (targetFolder instanceof TFolder) {
                        const newPath = `${targetFolderPath}/${task.file.name}`;
                        await vault.rename(task.file, newPath);
                        movedCount++;
                    }
                } catch (error) {
                    console.error(`Error moving task ${task.file.path}:`, error);
                }
            }
        }

        new Notice(`Organized ${movedCount} tasks by tag`);
        this.refreshView();
    }

    // Organize tasks in a specific folder by tag
    async organizeTasksInFolder(folder: TFolder) {
        const files = this.collectMarkdownFiles(folder);
        let movedCount = 0;
        const vault = this.app.vault;

        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            const tag = cache?.frontmatter?.tag || 'untagged';

            // Skip if already in correct folder
            const currentFolder = file.parent?.name;
            if (currentFolder === tag) continue;

            const targetFolderPath = `${folder.path}/${tag}`;
            
            try {
                // Create target folder if it doesn't exist
                let targetFolder = vault.getAbstractFileByPath(targetFolderPath);
                if (!targetFolder) {
                    await vault.createFolder(targetFolderPath);
                    targetFolder = vault.getAbstractFileByPath(targetFolderPath);
                }

                if (targetFolder instanceof TFolder) {
                    const newPath = `${targetFolderPath}/${file.name}`;
                    await vault.rename(file, newPath);
                    movedCount++;
                }
            } catch (error) {
                console.error(`Error moving task ${file.path}:`, error);
            }
        }

        new Notice(`Organized ${movedCount} tasks in ${folder.name} by tag`);
        this.refreshView();
    }

    // Find the base task folder for a file
    private findBaseTaskFolder(file: TFile): TFolder | null {
        let current = file.parent;
        
        while (current) {
            if (this.settings.taskFolders.some(tf => 
                current!.path === tf || 
                current!.path.endsWith('/' + tf) ||
                current!.name === tf
            )) {
                return current;
            }
            current = current.parent;
        }
        
        return null;
    }
}

// Task Board View
class TaskBoardView extends ItemView {
    plugin: TaskBoardPlugin;
    tasks: Task[] = [];
    filteredTasks: Task[] = [];
    containerEl: HTMLElement;
    sortSelect: DropdownComponent;
    selectedTags: Set<string> = new Set();
    tagFilterContainer: HTMLElement | null = null;
    hiddenStatuses: Set<string> = new Set();
    searchQuery: string = '';
    searchInput: HTMLInputElement | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: TaskBoardPlugin) {
        super(leaf);
        this.plugin = plugin;
        // Initialize hidden statuses from settings
        this.hiddenStatuses = new Set(this.plugin.settings.hiddenStatuses || []);
    }

    getViewType(): string {
        return VIEW_TYPE_TASK_BOARD;
    }

    getDisplayText(): string {
        return 'Task Board';
    }

    getIcon(): string {
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
        let debounceTimer: number;
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
        const sortSelect = new DropdownComponent(controls);
        sortSelect.addOption('priority', 'Priority');
        sortSelect.addOption('tag', 'Tag');
        sortSelect.addOption('title', 'Title');
        sortSelect.addOption('folder', 'Folder');
        sortSelect.setValue(this.plugin.settings.sortBy);
        sortSelect.onChange((value) => {
            this.plugin.settings.sortBy = value as any;
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
            } else {
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
            } else {
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
    getAllTags(): string[] {
        const tags = new Set<string>();
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
        if (tags.length === 0) return;

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
                } else {
                    this.selectedTags.delete(tag);
                }
                this.applyFilters();
                this.renderBoard();
                // Update clear button visibility
                const clearBtn = this.containerEl.querySelector('.task-board-clear-filters') as HTMLElement;
                if (clearBtn) {
                    clearBtn.style.display = this.selectedTags.size > 0 ? 'inline-block' : 'none';
                }
            });
        }
    }

    renderBoard() {
        // Remove existing board if any
        const existingBoard = this.containerEl.querySelector('.task-board');
        if (existingBoard) existingBoard.remove();

        const board = this.containerEl.createDiv({ cls: 'task-board' });

        // Use pre-filtered tasks (search + tag filters already applied)
        const tasksToRender = this.filteredTasks;

        // Group tasks by status
        const tasksByStatus = new Map<string, Task[]>();
        
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
            tasksByStatus.get(status)!.push(task);
        }

        // Create columns (skip hidden statuses)
        for (const status of this.plugin.settings.statusOrder) {
            if (this.hiddenStatuses.has(status)) continue;
            const tasks = tasksByStatus.get(status) || [];
            
            // For active columns (todo, in-progress), use hierarchical grouping
            if (status === 'todo' || status === 'in-progress') {
                this.renderHierarchicalColumn(board, status, tasks);
            } else {
                // Sort and render flat for done/archive columns
                this.sortTasks(tasks);
                this.renderColumn(board, status, tasks);
            }
        }
    }

    // Group tasks by folder, then by tag
    groupTasksHierarchically(tasks: Task[]): Map<string, Map<string, Task[]>> {
        const folderGroups = new Map<string, Map<string, Task[]>>();

        for (const task of tasks) {
            const folder = task.folder || 'Uncategorized';
            const tag = task.tag || 'untagged';

            if (!folderGroups.has(folder)) {
                folderGroups.set(folder, new Map());
            }
            const tagGroups = folderGroups.get(folder)!;

            if (!tagGroups.has(tag)) {
                tagGroups.set(tag, []);
            }
            tagGroups.get(tag)!.push(task);
        }

        // Sort tasks within each tag group
        for (const [folder, tagGroups] of folderGroups) {
            for (const [tag, tagTasks] of tagGroups) {
                this.sortTasks(tagTasks);
            }
        }

        return folderGroups;
    }

    renderHierarchicalColumn(board: HTMLElement, status: string, tasks: Task[]) {
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
            const tagGroups = folderGroups.get(folderName)!;
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
    calculateColumnWidth(folderGroups: Map<string, Map<string, Task[]>>): number {
        const TAG_WIDTH = 200;      // Width per tag group (including padding & border)
        const TAG_GAP = 12;         // Gap between tags
        const SECTION_PADDING = 48; // Folder section internal padding (16px * 2 + margin)
        const COLUMN_PADDING = 48;  // Column content padding (12px * 2 + extra)
        const MIN_WIDTH = 400;      // Minimum column width

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
    calculateFolderWidth(tagGroups: Map<string, Task[]>): number {
        const TAG_WIDTH = 200;
        const TAG_GAP = 12;
        const PADDING = 48;

        const tagCount = tagGroups.size;
        const contentWidth = (tagCount * TAG_WIDTH) + ((tagCount - 1) * TAG_GAP);
        return contentWidth + PADDING;
    }

    renderFolderSection(container: HTMLElement, folderName: string, tagGroups: Map<string, Task[]>, width?: number, status?: string) {
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
            const tasks = tagGroups.get(tag)!;
            this.renderTagGroup(tagsContainer, folderName, tag, tasks);
        }
    }

    renderTagGroup(container: HTMLElement, folderName: string, tag: string, tasks: Task[]) {
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

    sortTasks(tasks: Task[]) {
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

    renderColumn(board: HTMLElement, status: string, tasks: Task[]) {
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
    setupDropZone(element: HTMLElement, type: 'status' | 'tag' | 'folder', value: string, folder?: TFolder) {
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
            if (!taskId) return;

            const task = this.tasks.find(t => t.id === taskId);
            if (!task) return;

            // Prevent dropping on same location
            if (type === 'status' && task.status === value) return;
            if (type === 'tag' && task.tag === value) return;
            if (type === 'folder' && folder && task.file.parent?.path === folder.path) return;

            // Perform the move
            if (type === 'status') {
                await this.plugin.updateTaskStatus(task, value);
            } else if (type === 'tag') {
                await this.plugin.updateTask(task, value);
            } else if (type === 'folder' && folder) {
                await this.plugin.moveTaskToFolder(task, folder);
            }

            this.refresh();
        });
    }

    renderTaskCard(container: HTMLElement, task: Task) {
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
                } catch (e) {
                    // Ignore document errors on mobile
                }
            });
        }
    }

    showPriorityMenu(task: Task, element: HTMLElement, evt: MouseEvent) {
        const menu = new Menu();
        
        const priorities = ['high', 'medium', 'low'] as const;
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

    showStatusMenu(task: Task, evt: MouseEvent) {
        const menu = new Menu();
        
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

    getStatusLabel(status: string): string {
        const labels: Record<string, string> = {
            'todo': 'To Do',
            'in-progress': 'In Progress',
            'done': 'Done',
            'archive': 'Archive'
        };
        return labels[status] || status.charAt(0).toUpperCase() + status.slice(1);
    }

    // Show dialog to create a new task in a specific folder and tag
    showNewTaskDialog(folderName: string, tag: string) {
        const modal = new NewTaskModal(this.app, folderName, tag, (title, folder, taskTag, priority) => {
            this.plugin.createNewTask(title, folder, taskTag, priority);
        });
        modal.open();
    }

    // Show dialog to create a new tag with a TODO item
    showNewTagDialog(folderName: string) {
        const modal = new NewTagModal(this.app, folderName, (tagName, title, priority) => {
            this.plugin.createNewTask(title, folderName, tagName, priority);
        });
        modal.open();
    }
}

// Modal for creating a new task
class NewTaskModal extends Modal {
    folder: string;
    tag: string;
    onSubmit: (title: string, folder: string, tag: string, priority: string) => void;

    constructor(app: App, folder: string, tag: string, onSubmit: (title: string, folder: string, tag: string, priority: string) => void) {
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
            if (p === 'medium') option.selected = true;
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
class NewTagModal extends Modal {
    folder: string;
    onSubmit: (tagName: string, title: string, priority: string) => void;

    constructor(app: App, folder: string, onSubmit: (tagName: string, title: string, priority: string) => void) {
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
            if (p === 'medium') option.selected = true;
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
class TaskBoardSettingTab extends PluginSettingTab {
    plugin: TaskBoardPlugin;

    constructor(app: App, plugin: TaskBoardPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Task Board Settings' });

        // Task folders
        new Setting(containerEl)
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
        new Setting(containerEl)
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
        new Setting(containerEl)
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
