const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const simpleGit = require('simple-git');
const { exec } = require('child_process');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 400,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });

  mainWindow.loadFile('index.html');

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('show-start-dialog');
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// Helper to find a valid game folder in src/Project Files
function findGameFolder(projectRoot) {
  const projectFilesDir = path.join(projectRoot, 'src', 'Project Files');
  if (!fs.existsSync(projectFilesDir)) return null;
  const entries = fs.readdirSync(projectFilesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const gameDir = path.join(projectFilesDir, entry.name);
      const indexHtml = path.join(gameDir, 'www', 'index.html');
      if (fs.existsSync(indexHtml)) {
        return { gameDir, gameFolderName: entry.name };
      }
    }
  }
  return null;
}

// Listen for user choice from renderer
ipcMain.on('start-choice', async (event, data) => {
  const choice = typeof data === 'string' ? data : data.choice;
  const projectName = data && data.projectName ? data.projectName.trim() : null;

  if (choice === 'new') {
    // 1. Ask user where to create the new project
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Folder to Create New Project',
      properties: ['openDirectory', 'createDirectory']
    });
    if (canceled || !filePaths.length) return;

    // 2. Validate project name
    if (!projectName) {
      dialog.showErrorBox('Error', 'No project name provided.');
      return;
    }

    // 3. Create the new project folder
    const projectRoot = path.join(filePaths[0], projectName);
    if (fs.existsSync(projectRoot)) {
      dialog.showErrorBox('Error', 'A folder with that name already exists.');
      return;
    }
    fs.mkdirSync(projectRoot);

    // 4. Clone the repo
    const git = simpleGit();
    mainWindow.webContents.send('progress', 'Cloning project template...');
    try {
      await git.clone('https://github.com/ReaperBecca/Game-Window---RMMVZ-Launcher---Free-Tier', projectRoot);
    } catch (err) {
      dialog.showErrorBox('Clone Error', err.message);
      return;
    }

    // 5. Remove .git folder so it's not a git repo
    await fs.remove(path.join(projectRoot, '.git'));

    // 6. Place identifier file
    const identifier = {
      launcher: 'RMMVZ-Launcher-Free-Tier',
      created: new Date().toISOString(),
      projectName
    };
    await fs.writeJson(path.join(projectRoot, '.rmmvzlauncher.json'), identifier, { spaces: 2 });

    // 7. Run npm install
    mainWindow.webContents.send('progress', 'Installing dependencies...');
    exec('npm install', { cwd: projectRoot }, (error, stdout, stderr) => {
      if (error) {
        dialog.showErrorBox('npm install error', stderr);
        return;
      }
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        message: `Project "${projectName}" created successfully!`,
        detail: `Location: ${projectRoot}`
      }).then(() => {
        // Tell renderer to open a new tab for this project
        const gameInfo = findGameFolder(projectRoot);
        mainWindow.webContents.send('open-project-tab', {
          projectName,
          projectRoot,
          hasGame: !!gameInfo,
          gameFolderName: gameInfo ? gameInfo.gameFolderName : null
        });
      });
    });
  } else if (choice === 'edit') {
    // Loop until user selects a valid project or cancels
    let keepPrompting = true;
    while (keepPrompting) {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Project to Edit',
        properties: ['openDirectory']
      });
      if (result.canceled) break;
      const selectedDir = result.filePaths[0];
      const identifierPath = path.join(selectedDir, '.rmmvzlauncher.json');
      if (fs.existsSync(identifierPath)) {
        // Read project info
        let projectInfo = {};
        try {
          projectInfo = await fs.readJson(identifierPath);
        } catch (e) {
          dialog.showErrorBox('Error', 'Could not read project identifier file.');
          continue;
        }
        // Open project tab in renderer
        const gameInfo = findGameFolder(selectedDir);
        mainWindow.webContents.send('open-project-tab', {
          projectName: projectInfo.projectName || path.basename(selectedDir),
          projectRoot: selectedDir,
          hasGame: !!gameInfo,
          gameFolderName: gameInfo ? gameInfo.gameFolderName : null
        });
        keepPrompting = false;
      } else {
        // Not a valid project, show error and prompt again
        const retry = await dialog.showMessageBox(mainWindow, {
          type: 'error',
          buttons: ['Select Again', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          title: 'Invalid Project Folder',
          message: 'The selected folder does not contain a .rmmvzlauncher.json file. Please select a valid project folder.'
        });
        if (retry.response === 1) {
          // Cancel
          keepPrompting = false;
        }
        // else, loop again
      }
    }
  }
});

// Handle importing RPG Maker game into project src/Project Files folder
ipcMain.on('import-rpg-game', async (event, { projectName, projectRoot }) => {
  // 1. Ask user to select a folder
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select RPG Maker Game Folder',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths.length) return;

  const selectedDir = result.filePaths[0];
  const indexHtmlPath = path.join(selectedDir, 'www', 'index.html');
  if (!fs.existsSync(indexHtmlPath)) {
    dialog.showErrorBox('Invalid Game Folder', 'The selected folder does not contain www/index.html. Please select a valid RPG Maker MV/MZ exported game folder.');
    return;
  }

  // 2. Copy the entire folder to project src/Project Files/{GameName}
  const gameFolderName = path.basename(selectedDir);
  const destDir = path.join(projectRoot, 'src', 'Project Files', gameFolderName);
  try {
    await fs.remove(destDir); // Remove existing if any
    await fs.copy(selectedDir, destDir);
    mainWindow.webContents.send('import-status', {
      projectName,
      status: 'success',
      message: `Game imported successfully to ${destDir}`
    });
  } catch (err) {
    mainWindow.webContents.send('import-status', {
      projectName,
      status: 'error',
      message: `Failed to import game: ${err.message}`
    });
    return;
  }

  // 3. After import, re-detect and update the project tab
  const gameInfo = findGameFolder(projectRoot);
  mainWindow.webContents.send('open-project-tab', {
    projectName,
    projectRoot,
    hasGame: !!gameInfo,
    gameFolderName: gameInfo ? gameInfo.gameFolderName : null
  });
});

// Handle building the installer
ipcMain.on('build-installer', async (event, { projectName, projectRoot, gameFolderName }) => {
  // Ask user where to save the installer
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Installer As',
    defaultPath: `${projectName}-installer.exe`,
    filters: [{ name: 'Windows Installer', extensions: ['exe'] }]
  });
  if (canceled || !filePath) return;

  // Run npm run build:win in the project directory
  const child = exec('npm run build:win', { cwd: projectRoot });

  // Optionally, send progress to renderer
  child.stdout.on('data', data => {
    mainWindow.webContents.send('build-status', { projectName, status: 'progress', message: data });
  });
  child.stderr.on('data', data => {
    mainWindow.webContents.send('build-status', { projectName, status: 'error', message: data });
  });

  child.on('exit', async (code) => {
    if (code === 0) {
      // Find the built installer in dist/
      const distDir = path.join(projectRoot, 'dist');
      const files = await fs.readdir(distDir);
      const exeFile = files.find(f => f.endsWith('.exe'));
      if (exeFile) {
        try {
          await fs.copyFile(path.join(distDir, exeFile), filePath);
          mainWindow.webContents.send('build-status', {
            projectName,
            status: 'success',
            message: `Installer built and saved to ${filePath}`
          });
        } catch (err) {
          mainWindow.webContents.send('build-status', {
            projectName,
            status: 'error',
            message: `Failed to save installer: ${err.message}`
          });
        }
      } else {
        mainWindow.webContents.send('build-status', {
          projectName,
          status: 'error',
          message: 'No installer found in dist directory.'
        });
      }
    } else {
      mainWindow.webContents.send('build-status', {
        projectName,
        status: 'error',
        message: `Build process exited with code ${code}`
      });
    }
  });
});
