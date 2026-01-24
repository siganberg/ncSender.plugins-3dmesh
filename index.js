/*
 * This file is part of ncSender.
 *
 * ncSender is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * ncSender is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with ncSender. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * 3DMesh Plugin
 * Surface mesh probing with Z compensation for milling curved materials
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

function getUserDataDir() {
  const platform = os.platform();
  const appName = 'ncSender';
  switch (platform) {
    case 'win32':
      return path.join(os.homedir(), 'AppData', 'Roaming', appName);
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', appName);
    case 'linux':
      return path.join(os.homedir(), '.config', appName);
    default:
      return path.join(os.homedir(), `.${appName}`);
  }
}

function getMeshFilePath() {
  return path.join(getUserDataDir(), 'plugin-config', 'com.ncsender.3dmesh', 'mesh.json');
}

// In-memory mesh storage
let currentMesh = null;
let meshGridParams = null;

// Analyze G-code to get bounding box
function analyzeGCodeBounds(gcodeContent) {
  const bounds = {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity }
  };

  let currentX = 0, currentY = 0, currentZ = 0;
  let isAbsolute = true;

  const lines = gcodeContent.split('\n');

  for (const line of lines) {
    const trimmed = line.trim().toUpperCase();

    if (trimmed.startsWith('(') || trimmed.startsWith(';') || trimmed.startsWith('%')) {
      continue;
    }

    if (trimmed.includes('G90') && !trimmed.includes('G90.1')) isAbsolute = true;
    if (trimmed.includes('G91') && !trimmed.includes('G91.1')) isAbsolute = false;

    if (trimmed.includes('G53')) continue;

    const xMatch = trimmed.match(/X([+-]?\d*\.?\d+)/);
    const yMatch = trimmed.match(/Y([+-]?\d*\.?\d+)/);
    const zMatch = trimmed.match(/Z([+-]?\d*\.?\d+)/);

    if (xMatch) {
      const val = parseFloat(xMatch[1]);
      currentX = isAbsolute ? val : currentX + val;
    }
    if (yMatch) {
      const val = parseFloat(yMatch[1]);
      currentY = isAbsolute ? val : currentY + val;
    }
    if (zMatch) {
      const val = parseFloat(zMatch[1]);
      currentZ = isAbsolute ? val : currentZ + val;
    }

    if (xMatch || yMatch || zMatch) {
      bounds.min.x = Math.min(bounds.min.x, currentX);
      bounds.min.y = Math.min(bounds.min.y, currentY);
      bounds.min.z = Math.min(bounds.min.z, currentZ);
      bounds.max.x = Math.max(bounds.max.x, currentX);
      bounds.max.y = Math.max(bounds.max.y, currentY);
      bounds.max.z = Math.max(bounds.max.z, currentZ);
    }
  }

  if (bounds.min.x === Infinity) bounds.min.x = 0;
  if (bounds.min.y === Infinity) bounds.min.y = 0;
  if (bounds.min.z === Infinity) bounds.min.z = 0;
  if (bounds.max.x === -Infinity) bounds.max.x = 0;
  if (bounds.max.y === -Infinity) bounds.max.y = 0;
  if (bounds.max.z === -Infinity) bounds.max.z = 0;

  return bounds;
}

// Bilinear interpolation for Z lookup
// Handles special cases: single row (1xN), single column (Nx1)
function interpolateZ(x, y, mesh, gridParams) {
  const { startX, startY, spacingX, spacingY, rows, cols } = gridParams;

  // Single column (Nx1): linear interpolation in Y only
  if (cols === 1) {
    if (rows === 1) return mesh[0][0]?.z ?? 0;
    const rowFloat = spacingY > 0 ? (y - startY) / spacingY : 0;
    const row = Math.max(0, Math.min(rows - 2, Math.floor(rowFloat)));
    const z0 = mesh[row][0]?.z ?? 0;
    const z1 = mesh[row + 1]?.[0]?.z ?? z0;
    const ty = Math.max(0, Math.min(1, rowFloat - row));
    return z0 * (1 - ty) + z1 * ty;
  }

  // Single row (1xN): linear interpolation in X only
  if (rows === 1) {
    const colFloat = spacingX > 0 ? (x - startX) / spacingX : 0;
    const col = Math.max(0, Math.min(cols - 2, Math.floor(colFloat)));
    const z0 = mesh[0][col]?.z ?? 0;
    const z1 = mesh[0][col + 1]?.z ?? z0;
    const tx = Math.max(0, Math.min(1, colFloat - col));
    return z0 * (1 - tx) + z1 * tx;
  }

  // Standard bilinear interpolation for 2D grid
  const colFloat = (x - startX) / spacingX;
  const rowFloat = (y - startY) / spacingY;

  const col = Math.max(0, Math.min(cols - 2, Math.floor(colFloat)));
  const row = Math.max(0, Math.min(rows - 2, Math.floor(rowFloat)));

  const z00 = mesh[row][col]?.z ?? 0;
  const z10 = mesh[row][col + 1]?.z ?? z00;
  const z01 = mesh[row + 1]?.[col]?.z ?? z00;
  const z11 = mesh[row + 1]?.[col + 1]?.z ?? z00;

  const tx = Math.max(0, Math.min(1, colFloat - col));
  const ty = Math.max(0, Math.min(1, rowFloat - row));

  return z00 * (1 - tx) * (1 - ty) + z10 * tx * (1 - ty) + z01 * (1 - tx) * ty + z11 * tx * ty;
}

// Apply Z compensation to G-code
function applyZCompensation(gcodeContent, mesh, gridParams, referenceZ) {
  const lines = gcodeContent.split('\n');
  const output = [];

  let currentX = 0, currentY = 0;
  let isAbsolute = true;

  output.push('(Z-Compensated G-code generated by 3DMesh Plugin)');
  output.push(`(Grid: ${gridParams.cols} x ${gridParams.rows} points)`);
  output.push(`(Reference Z: ${referenceZ.toFixed(3)})`);
  output.push('');

  for (const line of lines) {
    const trimmed = line.trim().toUpperCase();

    if (!trimmed || trimmed.startsWith('(') || trimmed.startsWith(';') || trimmed.startsWith('%')) {
      output.push(line);
      continue;
    }

    if (trimmed.includes('G90') && !trimmed.includes('G90.1')) isAbsolute = true;
    if (trimmed.includes('G91') && !trimmed.includes('G91.1')) isAbsolute = false;

    if (trimmed.includes('G53')) {
      output.push(line);
      continue;
    }

    const xMatch = line.match(/X([+-]?\d*\.?\d+)/i);
    const yMatch = line.match(/Y([+-]?\d*\.?\d+)/i);
    const zMatch = line.match(/Z([+-]?\d*\.?\d+)/i);

    if (xMatch) {
      const val = parseFloat(xMatch[1]);
      currentX = isAbsolute ? val : currentX + val;
    }
    if (yMatch) {
      const val = parseFloat(yMatch[1]);
      currentY = isAbsolute ? val : currentY + val;
    }

    if (zMatch && isAbsolute) {
      const originalZ = parseFloat(zMatch[1]);
      const meshZ = interpolateZ(currentX, currentY, mesh, gridParams);
      const zOffset = meshZ - referenceZ;
      const compensatedZ = originalZ + zOffset;

      const newLine = line.replace(/Z([+-]?\d*\.?\d+)/i, `Z${compensatedZ.toFixed(3)}`);
      output.push(newLine);
    } else {
      output.push(line);
    }
  }

  return output.join('\n');
}

// Save mesh to file
async function saveMeshToFile(mesh, gridParams) {
  const filePath = getMeshFilePath();
  const dir = path.dirname(filePath);

  await fs.mkdir(dir, { recursive: true });

  const data = {
    version: 1,
    timestamp: new Date().toISOString(),
    gridParams,
    mesh
  };

  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  return filePath;
}

// Load mesh from file
async function loadMeshFromFile() {
  const filePath = getMeshFilePath();

  const content = await fs.readFile(filePath, 'utf8');
  const data = JSON.parse(content);

  return {
    mesh: data.mesh,
    gridParams: data.gridParams
  };
}

// Track last processed timestamp to avoid reprocessing
let lastProcessedTimestamp = 0;
let checkIntervalId = null;

export async function onLoad(ctx) {
  ctx.log('3DMesh plugin loaded');

  // Try to load saved mesh on startup
  try {
    const { mesh, gridParams } = await loadMeshFromFile();
    currentMesh = mesh;
    meshGridParams = gridParams;
    ctx.log('Loaded saved mesh:', gridParams.cols, 'x', gridParams.rows);
  } catch (error) {
    // No saved mesh, that's fine
  }

  // Periodically check for applyCompensation flag in settings
  const checkInterval = setInterval(async () => {
    try {
      const settings = ctx.getSettings() || {};

      // Check if there's a pending apply request
      if (settings.applyCompensation && settings.applyTimestamp && settings.applyTimestamp > lastProcessedTimestamp) {
        ctx.log('Processing applyCompensation request, timestamp:', settings.applyTimestamp);
        lastProcessedTimestamp = settings.applyTimestamp;

        // Get mesh data from settings or use stored mesh
        const mesh = settings.meshData?.mesh || currentMesh;
        const gridParams = settings.meshData?.gridParams || meshGridParams;

        if (!mesh || !gridParams) {
          ctx.log('No mesh data available for compensation');
          ctx.setSettings({
            ...settings,
            applyCompensation: false,
            lastApplyResult: { success: false, error: 'No mesh data available' }
          });
          return;
        }

        // Update in-memory mesh
        if (settings.meshData) {
          currentMesh = settings.meshData.mesh;
          meshGridParams = settings.meshData.gridParams;
        }

        try {
          const cacheFilePath = path.join(getUserDataDir(), 'gcode-cache', 'current.gcode');
          const gcodeContent = await fs.readFile(cacheFilePath, 'utf8');

          const referenceZ = settings.referenceZ ?? 0;
          ctx.log('Applying Z compensation with referenceZ:', referenceZ);
          ctx.log('Grid:', gridParams.cols, 'x', gridParams.rows);

          const compensatedGcode = applyZCompensation(gcodeContent, mesh, gridParams, referenceZ);

          const serverState = ctx.getServerState();
          const originalFilename = serverState?.jobLoaded?.filename || 'program.nc';
          const outputFilename = originalFilename.replace(/\.[^.]+$/, '') + '_compensated.nc';

          ctx.log('Loading compensated file:', outputFilename);

          // Load the compensated G-code via API
          const response = await fetch('http://localhost:8090/api/gcode-files/load-temp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: compensatedGcode,
              filename: outputFilename,
              sourceFile: originalFilename
            })
          });

          if (response.ok) {
            ctx.log('Compensation applied successfully');
            ctx.setSettings({
              ...settings,
              applyCompensation: false,
              lastApplyResult: { success: true, filename: outputFilename }
            });
          } else {
            ctx.log('Failed to load compensated file:', response.status);
            ctx.setSettings({
              ...settings,
              applyCompensation: false,
              lastApplyResult: { success: false, error: 'Failed to load compensated file' }
            });
          }
        } catch (error) {
          ctx.log('Apply compensation error:', error.message);
          ctx.setSettings({
            ...settings,
            applyCompensation: false,
            lastApplyResult: { success: false, error: error.message }
          });
        }
      }
    } catch (error) {
      // Ignore check errors
    }
  }, 500); // Check every 500ms

  // Store interval for cleanup
  checkIntervalId = checkInterval;

  ctx.registerToolMenu('3DMesh', async () => {
    ctx.log('3DMesh tool clicked');

    const savedSettings = ctx.getSettings() || {};
    const settings = {
      gridMode: savedSettings.gridMode || 'manual',
      rows: savedSettings.rows ?? 5,
      cols: savedSettings.cols ?? 5,
      sizeX: savedSettings.sizeX ?? 100,
      sizeY: savedSettings.sizeY ?? 100,
      probeFeedRate: savedSettings.probeFeedRate ?? 100,
      travelFeedRate: savedSettings.travelFeedRate ?? 2000,
      clearanceHeight: savedSettings.clearanceHeight ?? 5,
      maxPlunge: savedSettings.maxPlunge ?? 20,
      referenceZ: savedSettings.referenceZ ?? 0
    };

    const appSettings = ctx.getAppSettings();
    const unitsPreference = appSettings.unitsPreference || 'metric';
    const isImperial = unitsPreference === 'imperial';
    const distanceUnit = isImperial ? 'in' : 'mm';
    const feedUnit = isImperial ? 'in/min' : 'mm/min';

    const serverState = ctx.getServerState();
    const jobLoaded = serverState?.jobLoaded;
    const hasGcode = !!jobLoaded?.filename;

    let gcodeBounds = null;
    if (hasGcode) {
      try {
        const cacheFilePath = path.join(getUserDataDir(), 'gcode-cache', 'current.gcode');
        const gcodeContent = await fs.readFile(cacheFilePath, 'utf8');
        gcodeBounds = analyzeGCodeBounds(gcodeContent);
      } catch (error) {
        ctx.log('Failed to analyze G-code bounds:', error);
      }
    }

    const hasMesh = currentMesh !== null && meshGridParams !== null;

    // Serialize mesh data for client
    const meshDataJson = hasMesh ? JSON.stringify({ mesh: currentMesh, gridParams: meshGridParams }) : 'null';

    showMainDialog(ctx, {
      settings,
      isImperial,
      distanceUnit,
      feedUnit,
      hasGcode,
      gcodeBounds,
      hasMesh,
      meshDataJson,
      filename: jobLoaded?.filename
    });
  }, { icon: 'logo.png' });

  // Listen for mesh updates from client
  ctx.onWebSocketEvent('plugin:3dmesh:save-mesh', async (data) => {
    if (data && data.mesh && data.gridParams) {
      currentMesh = data.mesh;
      meshGridParams = data.gridParams;
      try {
        await saveMeshToFile(currentMesh, meshGridParams);
        ctx.log('Mesh saved to file');
      } catch (error) {
        ctx.log('Failed to save mesh:', error);
      }
    }
  });

}

function showMainDialog(ctx, params) {
  const {
    settings,
    isImperial,
    distanceUnit,
    feedUnit,
    hasGcode,
    gcodeBounds,
    hasMesh,
    meshDataJson,
    filename
  } = params;

  const MM_TO_INCH = 0.0393701;
  const convertToDisplay = (value) => isImperial ? parseFloat((value * MM_TO_INCH).toFixed(3)) : value;

  const boundsInfo = gcodeBounds
    ? `X: ${convertToDisplay(gcodeBounds.min.x).toFixed(1)} to ${convertToDisplay(gcodeBounds.max.x).toFixed(1)}, Y: ${convertToDisplay(gcodeBounds.min.y).toFixed(1)} to ${convertToDisplay(gcodeBounds.max.y).toFixed(1)}`
    : 'No G-code loaded';

  const gcodeBoundsJson = gcodeBounds ? JSON.stringify(gcodeBounds) : 'null';

  ctx.showDialog(
    '3DMesh - Surface Probing',
    /* html */ `
    <style>
      .mesh-dialog { padding: 20px 20px 10px 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: var(--color-text-primary); width: 750px; }
      .mesh-tabs { display: flex; gap: 2px; padding: 4px 16px 0 16px; background: var(--color-surface-muted); border: 1px solid var(--color-border); border-bottom: 1px solid var(--color-border); }
      .mesh-tab { all: unset; padding: 10px 20px; cursor: pointer; background: transparent !important; border: none !important; border-radius: 4px 4px 0 0 !important; color: var(--color-text-secondary) !important; font-size: 0.95rem; font-weight: 500; position: relative; transition: all 0.2s ease; margin-top: 4px; box-sizing: border-box; }
      .mesh-tab.active { background: var(--color-surface) !important; color: var(--color-text-primary) !important; box-shadow: 0 -2px 8px rgba(0,0,0,0.15); }
      .mesh-tab.active::after { content: ''; position: absolute; bottom: -1px; left: 0; right: 0; height: 2px; background: var(--color-accent); border-radius: 2px 2px 0 0; }
      .mesh-tab:hover:not(.active) { background: var(--color-surface) !important; color: var(--color-text-primary) !important; transform: translateY(-1px); }
      .mesh-panel { display: none; padding: 20px; border-left: 1px solid var(--color-border); border-right: 1px solid var(--color-border); border-bottom: 1px solid var(--color-border); min-height: 520px; max-height: 520px; overflow-y: auto; }
      .mesh-panel.active { display: block; }
      .form-section { background: var(--color-surface-muted); border: 1px solid var(--color-border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
      .form-section-title { font-weight: 600; margin-bottom: 12px; color: var(--color-text-primary); }
      .form-row { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 12px; }
      .form-row.three-col { grid-template-columns: repeat(3, 1fr); }
      .form-group { display: flex; flex-direction: column; }
      .form-group label { font-size: 0.85rem; font-weight: 500; margin-bottom: 4px; color: var(--color-text-primary); }
      .form-group input, .form-group select { padding: 8px 10px; border: 1px solid var(--color-border); border-radius: 4px; font-size: 0.9rem; background: var(--color-surface); color: var(--color-text-primary); }
      .form-group input:focus, .form-group select:focus { outline: none; border-color: var(--color-accent); }
      .info-box { background: var(--color-surface-muted); border: 1px solid var(--color-border); border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; font-size: 0.9rem; }
      .info-box.success { border-color: #4caf50; background: rgba(76, 175, 80, 0.1); }
      .info-box.warning { border-color: #ff9800; background: rgba(255, 152, 0, 0.1); }
      .mesh-status { display: flex; align-items: center; gap: 8px; }
      .status-dot { width: 10px; height: 10px; border-radius: 50%; background: #666; }
      .status-dot.active { background: #4caf50; }
      .button-row { display: flex; justify-content: center; gap: 10px; margin-top: 16px; padding: 16px 20px; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: 8px; }
      .button-row.inline { background: transparent; border: none; padding: 0; margin-top: 16px; }
      .btn { padding: 10px 24px; border-radius: 4px; font-size: 0.9rem; font-weight: 500; cursor: pointer; transition: background-color 0.2s; border: none; }
      .btn-secondary { background: var(--color-surface); border: 1px solid var(--color-border); color: var(--color-text-primary); }
      .btn-secondary:hover { background: var(--color-surface-muted); }
      .btn-primary { background: var(--color-accent); color: white; }
      .btn-primary:hover { opacity: 0.9; }
      .btn-primary:disabled, .btn-success:disabled { opacity: 0.5; cursor: not-allowed; }
      .btn-success { background: #4caf50; color: white; }
      .btn-danger { background: #f44336; color: white; }
      .probe-progress { border: 1px solid var(--color-border); border-radius: 4px; padding: 16px; background: var(--color-surface); min-height: 120px; }
      .progress-bar { height: 8px; background: var(--color-surface-muted); border-radius: 4px; overflow: hidden; margin: 10px 0; }
      .progress-fill { height: 100%; background: var(--color-accent); transition: width 0.3s; }
      .mesh-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
      .mesh-table th, .mesh-table td { padding: 4px 8px; border: 1px solid var(--color-border); text-align: center; }
      .mesh-table th { background: var(--color-surface-muted); }
    </style>

    <div class="mesh-dialog">
      <div class="mesh-tabs">
        <button class="mesh-tab active" data-tab="setup">Setup</button>
        <button class="mesh-tab" data-tab="probe">Probe</button>
        <button class="mesh-tab" data-tab="mesh">Mesh Data</button>
        <button class="mesh-tab" data-tab="apply">Apply</button>
      </div>

      <!-- Setup Tab -->
      <div class="mesh-panel active" id="panel-setup">
        <div class="form-section">
          <div class="form-section-title">Grid Configuration</div>
          <div class="form-row">
            <div class="form-group">
              <label>Grid Mode</label>
              <select id="gridMode">
                <option value="manual" ${settings.gridMode === 'manual' ? 'selected' : ''}>Manual</option>
                <option value="auto" ${settings.gridMode === 'auto' ? 'selected' : ''} ${!hasGcode ? 'disabled' : ''}>Auto from G-code</option>
              </select>
            </div>
            <div class="form-group">
              <label>Grid Size</label>
              <div style="display: flex; gap: 8px; align-items: center;">
                <input type="number" id="cols" value="${settings.cols}" min="1" max="50" style="width: 60px;">
                <span>x</span>
                <input type="number" id="rows" value="${settings.rows}" min="1" max="50" style="width: 60px;">
                <span>points</span>
              </div>
            </div>
          </div>
          <div id="manualGridSettings">
            <div class="form-row">
              <div class="form-group">
                <label>Size X (${distanceUnit})</label>
                <input type="number" id="sizeX" value="${convertToDisplay(settings.sizeX)}" step="0.1" min="0">
              </div>
              <div class="form-group">
                <label>Size Y (${distanceUnit})</label>
                <input type="number" id="sizeY" value="${convertToDisplay(settings.sizeY)}" step="0.1" min="0">
              </div>
            </div>
            <p class="info-text" style="margin: 8px 0; font-size: 12px; color: var(--color-text-secondary);">
              Position machine at starting corner before probing. Grid probes from current position.
            </p>
          </div>
          <div id="autoGridInfo" style="display: ${settings.gridMode === 'auto' ? 'block' : 'none'};">
            <div class="info-box"><strong>G-code Bounds:</strong> ${boundsInfo}</div>
          </div>
        </div>

        <div class="form-section">
          <div class="form-section-title">Probe Settings</div>
          <div class="form-row">
            <div class="form-group">
              <label>Probe Feed Rate (${feedUnit})</label>
              <input type="number" id="probeFeedRate" value="${settings.probeFeedRate}" min="1" max="1000">
            </div>
            <div class="form-group">
              <label>Travel Feed Rate (${feedUnit})</label>
              <input type="number" id="travelFeedRate" value="${settings.travelFeedRate || 2000}" min="100" max="5000">
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Clearance Height (${distanceUnit})</label>
              <input type="number" id="clearanceHeight" value="${convertToDisplay(settings.clearanceHeight || 5)}" min="1" step="0.5">
            </div>
            <div class="form-group">
              <label>Max Plunge (${distanceUnit})</label>
              <input type="number" id="maxPlunge" value="${convertToDisplay(settings.maxPlunge)}" min="1" step="0.1">
            </div>
          </div>
        </div>

        <div class="info-box" id="meshStatusBox">
          <div class="mesh-status">
            <div class="status-dot" id="meshStatusDot"></div>
            <span id="meshStatusText">Checking mesh status...</span>
          </div>
        </div>
      </div>

      <!-- Probe Tab -->
      <div class="mesh-panel" id="panel-probe">
        <div class="info-box warning">
          <strong>Before Probing:</strong>
          <ul style="margin: 8px 0 0 20px; padding: 0;">
            <li>Ensure probe is connected and working</li>
            <li>Position spindle at the starting corner above the work</li>
            <li>Safe probing uses G38.3 for lateral moves, G1 for Z retracts</li>
            <li>Curved surfaces detected via lateral probe checks</li>
          </ul>
        </div>

        <div class="form-section">
          <div class="form-section-title">Probe Progress</div>
          <div class="probe-progress" id="probeProgress">
            <div id="probeStatus">Click "Start Probing" to begin mesh probing sequence</div>
            <div class="progress-bar" style="display: none;" id="progressBarContainer">
              <div class="progress-fill" id="progressFill" style="width: 0%"></div>
            </div>
            <div id="probeStats" style="margin-top: 10px; font-size: 0.85rem; color: var(--color-text-secondary);"></div>
          </div>
        </div>

        <div class="button-row inline">
          <button class="btn btn-primary" id="startProbeBtn">Start Probing</button>
          <button class="btn btn-danger" id="stopProbeBtn" style="display: none;">Stop</button>
        </div>
      </div>

      <!-- Mesh Data Tab -->
      <div class="mesh-panel" id="panel-mesh">
        <div class="info-box">
          <div class="mesh-status">
            <span class="status-dot" id="meshStatusDot"></span>
            <span id="meshStatusText">Checking...</span>
          </div>
        </div>

        <div class="form-section">
          <div class="form-section-title">Mesh Data</div>
          <div id="meshDataDisplay" style="max-height: 300px; overflow: auto;">
            <p style="text-align: center; color: var(--color-text-secondary);">No mesh data available</p>
          </div>
        </div>

        <div id="meshStatsDisplay" class="info-box" style="display: none;"></div>

        <div class="button-row inline">
          <button class="btn btn-secondary" id="saveMeshBtn" disabled>Save to File</button>
          <button class="btn btn-secondary" id="loadMeshBtn">Load from File</button>
          <button class="btn btn-secondary" id="clearMeshBtn" disabled>Clear</button>
        </div>
      </div>

      <!-- Apply Tab -->
      <div class="mesh-panel" id="panel-apply">
        <div class="info-box" id="applyStatusBox">
          <span id="applyStatusText">Checking requirements...</span>
        </div>

        <div class="form-section">
          <div class="form-section-title">Compensation Settings</div>
          <div class="form-row">
            <div class="form-group">
              <label>Reference Z (${distanceUnit})</label>
              <input type="number" id="referenceZ" value="${convertToDisplay(settings.referenceZ)}" step="0.001">
            </div>
            <div class="form-group">
              <label>Source File</label>
              <input type="text" value="${filename || 'No file loaded'}" disabled>
            </div>
          </div>
        </div>

        <div class="button-row inline">
          <button class="btn btn-success" id="applyCompensationBtn" disabled>Apply Z Compensation</button>
        </div>
      </div>

      <div class="button-row">
        <button class="btn btn-secondary" onclick="window.postMessage({ type: 'close-plugin-dialog' }, '*')">Close</button>
        <button class="btn btn-primary" id="saveSettingsBtn">Save Settings</button>
      </div>
    </div>

    <script>
      (function() {
        const isImperial = ${isImperial};
        const INCH_TO_MM = 25.4;
        const MM_TO_INCH = 0.0393701;
        const hasGcode = ${hasGcode};
        const gcodeBounds = ${gcodeBoundsJson};
        const convertToMetric = (value) => isImperial ? value * INCH_TO_MM : value;
        const convertToDisplay = (value) => isImperial ? value * MM_TO_INCH : value;

        // Calculate API base URL
        // When on Vite dev server (5174), API is on port 8090
        // When in production, use relative URLs
        const API_BASE = (function() {
          const port = window.location.port;
          const hostname = window.location.hostname;
          const protocol = window.location.protocol;
          console.log('[3DMesh] Detecting API base - port:', port, 'hostname:', hostname);
          if (port === '5174') {
            const base = protocol + '//' + hostname + ':8090';
            console.log('[3DMesh] Using dev API base:', base);
            return base;
          }
          console.log('[3DMesh] Using relative API base (production)');
          return '';
        })();

        // Mesh state
        let meshData = ${meshDataJson};
        let isProbing = false;
        let stopProbing = false;

        // Update UI based on mesh state
        function updateMeshStatus() {
          const hasMesh = meshData && meshData.mesh && meshData.gridParams;
          const statusDot = document.getElementById('meshStatusDot');
          const statusText = document.getElementById('meshStatusText');
          const statusBox = document.getElementById('meshStatusBox');

          if (hasMesh) {
            statusDot.classList.add('active');
            statusText.textContent = 'Mesh data loaded (' + meshData.gridParams.cols + 'x' + meshData.gridParams.rows + ' points)';
            statusBox.classList.add('success');
            document.getElementById('saveMeshBtn').disabled = false;
            document.getElementById('clearMeshBtn').disabled = false;
          } else {
            statusDot.classList.remove('active');
            statusText.textContent = 'No mesh data - run probing first';
            statusBox.classList.remove('success');
            document.getElementById('saveMeshBtn').disabled = true;
            document.getElementById('clearMeshBtn').disabled = true;
          }

          updateApplyStatus();
          updateMeshDisplay();
        }

        function updateApplyStatus() {
          const hasMesh = meshData && meshData.mesh && meshData.gridParams;
          const statusBox = document.getElementById('applyStatusBox');
          const statusText = document.getElementById('applyStatusText');
          const applyBtn = document.getElementById('applyCompensationBtn');

          if (hasGcode && hasMesh) {
            statusBox.classList.remove('warning');
            statusBox.classList.add('success');
            statusText.innerHTML = '<strong>Ready to apply:</strong> Mesh data and G-code loaded';
            applyBtn.disabled = false;
          } else {
            statusBox.classList.remove('success');
            statusBox.classList.add('warning');
            statusText.innerHTML = '<strong>Requirements:</strong> ' +
              (!hasGcode ? 'Load a G-code file' : '') +
              (!hasGcode && !hasMesh ? ' and ' : '') +
              (!hasMesh ? 'Run probing first' : '');
            applyBtn.disabled = true;
          }
        }

        function updateMeshDisplay() {
          const container = document.getElementById('meshDataDisplay');
          const statsDisplay = document.getElementById('meshStatsDisplay');

          if (!meshData || !meshData.mesh || !meshData.gridParams) {
            container.innerHTML = '<p style="text-align: center; color: var(--color-text-secondary);">No mesh data available</p>';
            statsDisplay.style.display = 'none';
            return;
          }

          const { mesh, gridParams } = meshData;

          // Calculate stats
          let minZ = Infinity, maxZ = -Infinity, sum = 0, count = 0;
          for (const row of mesh) {
            for (const point of row) {
              if (point && typeof point.z === 'number') {
                minZ = Math.min(minZ, point.z);
                maxZ = Math.max(maxZ, point.z);
                sum += point.z;
                count++;
              }
            }
          }
          const avgZ = count > 0 ? sum / count : 0;
          const range = maxZ - minZ;

          statsDisplay.innerHTML =
            '<strong>Statistics:</strong> ' +
            'Min Z: ' + convertToDisplay(minZ).toFixed(3) + ' | ' +
            'Max Z: ' + convertToDisplay(maxZ).toFixed(3) + ' | ' +
            'Range: ' + convertToDisplay(range).toFixed(3) + ' | ' +
            'Avg: ' + convertToDisplay(avgZ).toFixed(3);
          statsDisplay.style.display = 'block';

          // Build table
          let html = '<table class="mesh-table"><thead><tr><th></th>';
          for (let c = 0; c < gridParams.cols; c++) {
            html += '<th>C' + c + '</th>';
          }
          html += '</tr></thead><tbody>';

          for (let r = mesh.length - 1; r >= 0; r--) {
            html += '<tr><th>R' + r + '</th>';
            for (let c = 0; c < gridParams.cols; c++) {
              const point = mesh[r]?.[c];
              const z = point?.z;
              html += '<td>' + (typeof z === 'number' ? convertToDisplay(z).toFixed(3) : '-') + '</td>';
            }
            html += '</tr>';
          }
          html += '</tbody></table>';

          container.innerHTML = html;
        }

        // Tab switching
        document.querySelectorAll('.mesh-tab').forEach(tab => {
          tab.addEventListener('click', () => {
            document.querySelectorAll('.mesh-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.mesh-panel').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
          });
        });

        // Grid mode toggle
        document.getElementById('gridMode').addEventListener('change', (e) => {
          const isAuto = e.target.value === 'auto';
          document.getElementById('manualGridSettings').style.display = isAuto ? 'none' : 'block';
          document.getElementById('autoGridInfo').style.display = isAuto ? 'block' : 'none';

          if (isAuto && gcodeBounds) {
            // Calculate size from G-code bounds
            const gcSizeX = gcodeBounds.max.x - gcodeBounds.min.x;
            const gcSizeY = gcodeBounds.max.y - gcodeBounds.min.y;
            document.getElementById('sizeX').value = convertToDisplay(gcSizeX).toFixed(3);
            document.getElementById('sizeY').value = convertToDisplay(gcSizeY).toFixed(3);
          }
        });

        // Save settings
        document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
          const settings = {
            gridMode: document.getElementById('gridMode').value,
            rows: parseInt(document.getElementById('rows').value),
            cols: parseInt(document.getElementById('cols').value),
            sizeX: convertToMetric(parseFloat(document.getElementById('sizeX').value)),
            sizeY: convertToMetric(parseFloat(document.getElementById('sizeY').value)),
            probeFeedRate: parseFloat(document.getElementById('probeFeedRate').value),
            travelFeedRate: parseFloat(document.getElementById('travelFeedRate').value),
            clearanceHeight: convertToMetric(parseFloat(document.getElementById('clearanceHeight').value)),
            maxPlunge: convertToMetric(parseFloat(document.getElementById('maxPlunge').value)),
            referenceZ: convertToMetric(parseFloat(document.getElementById('referenceZ').value))
          };

          try {
            await fetch(API_BASE + '/api/plugins/com.ncsender.3dmesh/settings', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(settings)
            });
            alert('Settings saved!');
          } catch (error) {
            alert('Failed to save settings');
          }
        });

        // Send CNC command helper
        async function sendCommand(command) {
          const url = API_BASE + '/api/send-command';
          console.log('[3DMesh] sendCommand URL:', url, 'command:', command);
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              command,
              meta: { sourceId: 'plugin', plugin: 'com.ncsender.3dmesh' }
            })
          });
          const result = await response.json();
          if (result.error || result.success === false) {
            const errorMsg = result.error?.message || result.error || 'Unknown error';
            throw new Error('Command failed: ' + errorMsg);
          }
          return result;
        }

        // Parse position string "X,Y,Z,A" to object
        function parsePositionString(posStr) {
          if (!posStr || typeof posStr !== 'string') return null;
          const parts = posStr.split(',').map(v => parseFloat(v.trim()));
          if (parts.length >= 3 && parts.every(v => !isNaN(v))) {
            return { x: parts[0], y: parts[1], z: parts[2] };
          }
          return null;
        }

        // Wait for machine to be idle (motion complete)
        async function waitForIdle(maxWaitMs = 10000) {
          const startTime = Date.now();
          while (Date.now() - startTime < maxWaitMs) {
            await new Promise(r => setTimeout(r, 100));
            try {
              const response = await fetch(API_BASE + '/api/server-state');
              const state = await response.json();
              const ms = state?.machineState;
              const status = ms?.status;
              if (status === 'Idle') {
                return true;
              }
              if (status === 'Alarm') {
                throw new Error('Machine in alarm state');
              }
            } catch (err) {
              console.log('[3DMesh] Error checking state:', err.message);
            }
          }
          console.log('[3DMesh] Warning: Timeout waiting for idle');
          return false;
        }

        // Query probe result by reading current machine position
        // After probing, machine stays at contact point
        async function queryProbeResult() {
          // Wait for motion to complete
          await waitForIdle();

          // Get current machine state
          const stateResponse = await fetch(API_BASE + '/api/server-state');
          const state = await stateResponse.json();
          // Handle both possible state structures
          const ms = state?.machineState || state?.cnc?.machineState;

          if (!ms) {
            console.log('[3DMesh] Warning: No machine state available');
            return null;
          }

          // Try WPos first (work position), then MPos (machine position) with WCO offset
          const wposStr = ms?.WPos;
          const mposStr = ms?.MPos;
          const wcoStr = ms?.WCO;

          // Parse WPos if available
          if (wposStr) {
            const wpos = parsePositionString(wposStr);
            if (wpos) {
              console.log('[3DMesh] Probe position from WPos:', JSON.stringify(wpos));
              return { ...wpos, success: true };
            }
          }

          // Calculate WPos from MPos - WCO
          if (mposStr && wcoStr) {
            const mpos = parsePositionString(mposStr);
            const wco = parsePositionString(wcoStr);
            if (mpos && wco) {
              const wpos = {
                x: mpos.x - wco.x,
                y: mpos.y - wco.y,
                z: mpos.z - wco.z
              };
              console.log('[3DMesh] Probe position (MPos-WCO):', JSON.stringify(wpos));
              return { ...wpos, success: true };
            }
          }

          // Fallback to MPos directly
          if (mposStr) {
            const mpos = parsePositionString(mposStr);
            if (mpos) {
              console.log('[3DMesh] Probe position from MPos:', JSON.stringify(mpos));
              return { ...mpos, success: true };
            }
          }

          console.log('[3DMesh] No position in state:', JSON.stringify(ms));
          return null;
        }

        // Start probing
        document.getElementById('startProbeBtn').addEventListener('click', async () => {
          if (isProbing) return;

          const rows = parseInt(document.getElementById('rows').value);
          const cols = parseInt(document.getElementById('cols').value);
          const sizeX = convertToMetric(parseFloat(document.getElementById('sizeX').value));
          const sizeY = convertToMetric(parseFloat(document.getElementById('sizeY').value));
          const probeFeedRate = parseFloat(document.getElementById('probeFeedRate').value);
          const travelFeedRate = parseFloat(document.getElementById('travelFeedRate').value);
          const clearanceHeight = convertToMetric(parseFloat(document.getElementById('clearanceHeight').value));
          const maxPlunge = convertToMetric(parseFloat(document.getElementById('maxPlunge').value));

          // Handle single row/column - spacing is 0, all points at start position
          const spacingX = cols > 1 ? sizeX / (cols - 1) : 0;
          const spacingY = rows > 1 ? sizeY / (rows - 1) : 0;

          // Validate all parameters before starting
          const params = { rows, cols, sizeX, sizeY, spacingX, spacingY, probeFeedRate, travelFeedRate, clearanceHeight, maxPlunge };
          const invalidParams = Object.entries(params).filter(([k, v]) => isNaN(v) || v === null || v === undefined);
          if (invalidParams.length > 0) {
            alert('Invalid parameters: ' + invalidParams.map(([k, v]) => k + '=' + v).join(', '));
            return;
          }

          if (cols < 1 || rows < 1) {
            alert('Grid must have at least 1 point in each direction');
            return;
          }

          if (cols === 1 && rows === 1) {
            alert('Grid must have more than 1 point total');
            return;
          }

          console.log('[3DMesh] Starting probe with params:', JSON.stringify(params));

          isProbing = true;
          stopProbing = false;

          document.getElementById('startProbeBtn').style.display = 'none';
          document.getElementById('stopProbeBtn').style.display = 'inline-block';
          document.getElementById('progressBarContainer').style.display = 'block';

          const totalPoints = rows * cols;
          let completedPoints = 0;
          const mesh = [];

          const updateProgress = (message) => {
            document.getElementById('probeStatus').textContent = message;
            document.getElementById('progressFill').style.width = (completedPoints / totalPoints * 100) + '%';
            document.getElementById('probeStats').textContent =
              'Completed: ' + completedPoints + ' / ' + totalPoints + ' points';
          };

          // Safe probe move - uses G38.3 (no error on no contact) for travel
          // This is safer than G0 as it will stop if probe triggers
          const safeMove = async (axis, value, feedRate) => {
            if (isNaN(value) || isNaN(feedRate)) {
              throw new Error('Invalid value in safeMove: axis=' + axis + ' value=' + value + ' feedRate=' + feedRate);
            }
            const cmd = 'G38.3 ' + axis + value.toFixed(3) + ' F' + feedRate.toFixed(0);
            await sendCommand(cmd);
            await new Promise(r => setTimeout(r, 100));
          };

          // Safe retract - use G1 for upward Z moves (no crash risk going up)
          // G38.4 requires probe to be triggered first, which isn't always the case
          const safeRetract = async (targetZ, feedRate) => {
            if (isNaN(targetZ) || isNaN(feedRate)) {
              throw new Error('Invalid value in safeRetract: targetZ=' + targetZ + ' feedRate=' + feedRate);
            }
            const cmd = 'G1 Z' + targetZ.toFixed(3) + ' F' + feedRate.toFixed(0);
            await sendCommand(cmd);
            await new Promise(r => setTimeout(r, 100));
          };

          try {
            // Set absolute mode
            await sendCommand('G90');
            await new Promise(r => setTimeout(r, 100));

            // Capture actual starting position before probing
            const startPos = await queryProbeResult();
            if (!startPos || startPos.x === undefined || startPos.y === undefined) {
              throw new Error('Could not read machine position. Make sure machine is connected.');
            }
            const actualStartX = startPos.x;
            const actualStartY = startPos.y;
            console.log('[3DMesh] Starting position: X=' + actualStartX.toFixed(3) + ' Y=' + actualStartY.toFixed(3));

            // Initialize mesh array with actual positions
            for (let r = 0; r < rows; r++) {
              mesh[r] = [];
              for (let c = 0; c < cols; c++) {
                mesh[r][c] = { x: actualStartX + c * spacingX, y: actualStartY + r * spacingY, z: null };
              }
            }

            let lastProbedZ = null; // Track last probed Z for smart lateral moves
            let rowHighestZ = null; // Track highest Z in current row for safe row transitions
            let meshHighestZ = null; // Track highest Z in entire mesh for final retract

            // Probing strategy for curved surfaces:
            // - Grid is probed left-to-right, front-to-back
            // - After probing a point, retract clearanceHeight (5mm)
            // - Move laterally with G38.3 (probe toward, no error)
            // - If lateral probe triggers: surface found! Record Z, retract, continue lateral
            // - If lateral probe doesn't trigger: do plunge probe (G38.2)
            // - This handles both climbing and descending surfaces efficiently

            // Probe each point
            for (let r = 0; r < rows && !stopProbing; r++) {
              for (let c = 0; c < cols && !stopProbing; c++) {
                // Calculate actual probe positions relative to where user started
                const x = actualStartX + c * spacingX;
                const y = actualStartY + r * spacingY;
                const isFirstPoint = (r === 0 && c === 0);
                let foundZ = null;

                updateProgress('Point (' + (r+1) + ',' + (c+1) + ')...');

                if (isFirstPoint) {
                  // First point: user should already be at starting position
                  // Just probe down - no lateral movement needed
                  console.log('[3DMesh] First point - probing at current position');

                } else {
                  // Subsequent points: use smart lateral probing for safe navigation
                  // We're already at clearance height (retracted after previous probe)

                  let currentClearanceZ = (lastProbedZ || 0) + clearanceHeight;

                  // New row? Need to retract to highest Z from previous row for safe transition
                  if (c === 0 && r > 0) {
                    currentClearanceZ = (rowHighestZ || lastProbedZ || 0) + clearanceHeight;
                    console.log('[3DMesh] New row - retracting to highest Z=' + (rowHighestZ || 0).toFixed(3) + ' + clearance');
                    await safeRetract(currentClearanceZ, travelFeedRate);
                    rowHighestZ = null; // Reset for new row
                  }
                  // Within same row: already at clearance from previous probe retract, no need to retract again

                  // Lateral probe moves with bounce-on-hit strategy
                  // This safely navigates over curved surfaces without crashing
                  // G38.3 stops if probe triggers, then we bounce up and continue

                  // New row: need to move both X (back to start) and Y (to next row)
                  if (c === 0 && r > 0) {
                    updateProgress('Moving to row ' + (r+1) + '...');

                    // First move X back to actual start position
                    await safeMove('X', actualStartX, travelFeedRate);
                    let pos = await queryProbeResult();

                    while (pos && Math.abs(pos.x - actualStartX) > 0.1 && !stopProbing) {
                      console.log('[3DMesh] Lateral X hit at X=' + pos.x.toFixed(3) + ' Z=' + pos.z.toFixed(3) + ' - bouncing');
                      currentClearanceZ = pos.z + clearanceHeight;
                      await safeRetract(currentClearanceZ, travelFeedRate);
                      await safeMove('X', actualStartX, travelFeedRate);
                      pos = await queryProbeResult();
                    }

                    // Then move Y to next row
                    await safeMove('Y', y, travelFeedRate);
                    pos = await queryProbeResult();

                    while (pos && Math.abs(pos.y - y) > 0.1 && !stopProbing) {
                      console.log('[3DMesh] Lateral Y hit at Y=' + pos.y.toFixed(3) + ' Z=' + pos.z.toFixed(3) + ' - bouncing');
                      currentClearanceZ = pos.z + clearanceHeight;
                      await safeRetract(currentClearanceZ, travelFeedRate);
                      await safeMove('Y', y, travelFeedRate);
                      pos = await queryProbeResult();
                    }
                  } else if (c > 0) {
                    // Within same row: just move X
                    updateProgress('Moving to (' + (r+1) + ',' + (c+1) + ')...');
                    await safeMove('X', x, travelFeedRate);

                    let pos = await queryProbeResult();

                    while (pos && Math.abs(pos.x - x) > 0.1 && !stopProbing) {
                      console.log('[3DMesh] Lateral hit at X=' + pos.x.toFixed(3) + ' Z=' + pos.z.toFixed(3) + ' - bouncing');
                      currentClearanceZ = pos.z + clearanceHeight;
                      await safeRetract(currentClearanceZ, travelFeedRate);
                      await safeMove('X', x, travelFeedRate);
                      pos = await queryProbeResult();
                    }
                  }
                }

                // Always do plunge probe at target X,Y to get accurate Z measurement
                updateProgress('Probing (' + (r+1) + ',' + (c+1) + ')...');

                // IMPORTANT: Ensure probe is not in contact before plunge
                // If lateral G38.3 hit surface at target position, probe is still triggered
                // Must retract first or G38.2 will ALARM:4
                if (!isFirstPoint) {
                  const preProbePos = await queryProbeResult();
                  if (preProbePos && preProbePos.z !== null) {
                    const safeZ = preProbePos.z + clearanceHeight;
                    console.log('[3DMesh] Pre-plunge retract to Z=' + safeZ.toFixed(3));
                    await safeRetract(safeZ, travelFeedRate);
                  }
                }

                const probeCmd = 'G38.2 Z-' + maxPlunge.toFixed(3) + ' F' + probeFeedRate.toFixed(0);
                await sendCommand(probeCmd);

                try {
                  const prb = await queryProbeResult();

                  if (prb && prb.success) {
                    // Store actual probed position (x, y calculated from actual start)
                    mesh[r][c].x = x;
                    mesh[r][c].y = y;
                    mesh[r][c].z = prb.z;

                    // Smart clearance: if surface is descending, use minimal clearance (1mm)
                    // If surface is ascending or first point, use full clearance
                    const isDescending = lastProbedZ !== null && prb.z < lastProbedZ;
                    const smartClearance = isDescending ? 1 : clearanceHeight;

                    // Now update lastProbedZ after the comparison
                    lastProbedZ = prb.z;

                    // Track highest Z in this row for safe row transitions
                    if (rowHighestZ === null || prb.z > rowHighestZ) {
                      rowHighestZ = prb.z;
                    }
                    // Track highest Z in entire mesh for final retract
                    if (meshHighestZ === null || prb.z > meshHighestZ) {
                      meshHighestZ = prb.z;
                    }
                    completedPoints++;
                    console.log('[3DMesh] Point (' + (r+1) + ',' + (c+1) + ') Z=' + prb.z.toFixed(3) + (isDescending ? ' (descending)' : ' (ascending)'));

                    const postProbeClearance = prb.z + smartClearance;
                    await safeRetract(postProbeClearance, travelFeedRate);
                    console.log('[3DMesh] Retracted to Z=' + postProbeClearance.toFixed(3) + ' (clearance: ' + smartClearance + 'mm)');
                  } else {
                    throw new Error('Probe did not contact surface');
                  }
                } catch (err) {
                  updateProgress('Error at (' + (r+1) + ',' + (c+1) + '): ' + err.message);
                  stopProbing = true;
                  break;
                }
              }
            }

            if (!stopProbing && completedPoints === totalPoints) {
              // Final retract - move to highest point + clearance for safe clearance
              if (meshHighestZ !== null) {
                const finalRetractZ = meshHighestZ + clearanceHeight;
                console.log('[3DMesh] Final retract to highest Z=' + meshHighestZ.toFixed(3) + ' + clearance = ' + finalRetractZ.toFixed(3));
                await safeRetract(finalRetractZ, travelFeedRate);

                // Return to starting position using G38.3 for safe movement
                console.log('[3DMesh] Returning to start position X=' + actualStartX.toFixed(3) + ' Y=' + actualStartY.toFixed(3));
                await safeMove('X', actualStartX, travelFeedRate);
                await safeMove('Y', actualStartY, travelFeedRate);
              }
              // Use actual start positions for gridParams so Z compensation works correctly
              const actualEndX = actualStartX + (cols - 1) * spacingX;
              const actualEndY = actualStartY + (rows - 1) * spacingY;
              meshData = {
                mesh,
                gridParams: { rows, cols, startX: actualStartX, startY: actualStartY, endX: actualEndX, endY: actualEndY, spacingX, spacingY }
              };

              // Save mesh to server
              await fetch(API_BASE + '/api/plugins/com.ncsender.3dmesh/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ meshData })
              });

              updateProgress('Probing complete! ' + totalPoints + ' points captured.');
              updateMeshStatus();
            } else if (stopProbing) {
              updateProgress('Probing stopped by user.');
            }
          } catch (error) {
            updateProgress('Error: ' + error.message);
          } finally {
            isProbing = false;
            document.getElementById('startProbeBtn').style.display = 'inline-block';
            document.getElementById('stopProbeBtn').style.display = 'none';
          }
        });

        // Stop probing
        document.getElementById('stopProbeBtn').addEventListener('click', () => {
          stopProbing = true;
          // Just set the flag - let the probing loop exit gracefully
          // Don't send feed hold or reset as it can cause alarms
        });

        // Save mesh to file
        document.getElementById('saveMeshBtn').addEventListener('click', async () => {
          if (!meshData) return;
          try {
            await fetch(API_BASE + '/api/plugins/com.ncsender.3dmesh/settings', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ meshData, saveMeshFile: true })
            });
            alert('Mesh saved to file!');
          } catch (error) {
            alert('Failed to save mesh: ' + error.message);
          }
        });

        // Load mesh from file
        document.getElementById('loadMeshBtn').addEventListener('click', async () => {
          try {
            const response = await fetch(API_BASE + '/api/plugins/com.ncsender.3dmesh/settings');
            const settings = await response.json();
            if (settings.meshData) {
              meshData = settings.meshData;
              updateMeshStatus();
              alert('Mesh loaded!');
            } else {
              alert('No saved mesh found.');
            }
          } catch (error) {
            alert('Failed to load mesh: ' + error.message);
          }
        });

        // Clear mesh
        document.getElementById('clearMeshBtn').addEventListener('click', () => {
          if (confirm('Clear mesh data?')) {
            meshData = null;
            updateMeshStatus();
          }
        });

        // Apply compensation
        document.getElementById('applyCompensationBtn').addEventListener('click', async () => {
          if (!meshData) {
            alert('No mesh data available');
            return;
          }

          const referenceZ = convertToMetric(parseFloat(document.getElementById('referenceZ').value));
          const applyBtn = document.getElementById('applyCompensationBtn');
          applyBtn.disabled = true;
          applyBtn.textContent = 'Applying...';

          try {
            console.log('[3DMesh] Applying compensation with referenceZ:', referenceZ);
            console.log('[3DMesh] Mesh data:', JSON.stringify(meshData.gridParams));

            // Save settings with applyCompensation flag and meshData
            // This will trigger the server to apply compensation
            const response = await fetch(API_BASE + '/api/plugins/com.ncsender.3dmesh/settings', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                referenceZ: referenceZ,
                meshData: meshData,
                applyCompensation: true,
                applyTimestamp: Date.now()
              })
            });

            if (!response.ok) {
              throw new Error('Failed to save settings');
            }

            // Wait a bit for server to process
            await new Promise(r => setTimeout(r, 500));

            // Check the result by fetching settings
            const checkResponse = await fetch(API_BASE + '/api/plugins/com.ncsender.3dmesh/settings');
            const settings = await checkResponse.json();

            console.log('[3DMesh] Settings after apply:', JSON.stringify(settings));

            if (settings.lastApplyResult?.success) {
              alert('Z compensation applied! File: ' + settings.lastApplyResult.filename);
              window.postMessage({ type: 'close-plugin-dialog' }, '*');
            } else if (settings.lastApplyResult?.error) {
              alert('Failed to apply compensation: ' + settings.lastApplyResult.error);
              applyBtn.disabled = false;
              applyBtn.textContent = 'Apply Z Compensation';
            } else {
              // Assume success if no explicit result
              alert('Z compensation applied! Check the loaded G-code.');
              window.postMessage({ type: 'close-plugin-dialog' }, '*');
            }
          } catch (error) {
            console.error('[3DMesh] Apply error:', error);
            alert('Failed to apply compensation: ' + error.message);
            applyBtn.disabled = false;
            applyBtn.textContent = 'Apply Z Compensation';
          }
        });

        // Initialize
        updateMeshStatus();
      })();
    </script>
    `,
    { closable: true, width: '750px' }
  );
}

export async function onUnload(ctx) {
  ctx.log('3DMesh plugin unloading');

  // Clear the check interval
  if (checkIntervalId) {
    clearInterval(checkIntervalId);
    checkIntervalId = null;
  }

  ctx.log('3DMesh plugin unloaded');
}
