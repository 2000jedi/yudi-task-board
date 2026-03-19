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
    Component
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
}

const DEFAULT_SETTINGS: TaskBoardSettings = {
    taskFolders: ['tasks'],
    statusOrder: ['todo', 'in-progress', 'done', 'archive'],
    defaultStatus: 'todo',
    sortBy: 'priority',
    sortDirection: 'desc',
    organizeByTag: false
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
    containerEl: HTMLElement;
    sortSelect: DropdownComponent;
    selectedTags: Set<string> = new Set();
    tagFilterContainer: HTMLElement | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: TaskBoardPlugin) {
        super(leaf);
        this.plugin = plugin;
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

        // Filter tasks by selected tags
        let filteredTasks = this.tasks;
        if (this.selectedTags.size > 0) {
            filteredTasks = this.tasks.filter(task => this.selectedTags.has(task.tag));
        }

        // Group tasks by status
        const tasksByStatus = new Map<string, Task[]>();
        
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
            tasksByStatus.get(status)!.push(task);
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

        // Tasks container
        const tasksContainer = column.createDiv({ cls: 'task-column-tasks' });

        // Render tasks
        for (const task of tasks) {
            this.renderTaskCard(tasksContainer, task);
        }
    }

    renderTaskCard(container: HTMLElement, task: Task) {
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
