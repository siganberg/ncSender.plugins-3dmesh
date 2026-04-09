/**
 * 3DMesh Plugin - Node.js Lifecycle Wrapper
 * Thin wrapper for the V2 (pro-v2) version.
 * Reads config.html and shows it as a dialog.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const resolveServerPort = (pluginSettings = {}, appSettings = {}) => {
  const appPort = Number.parseInt(appSettings?.senderPort, 10);
  if (Number.isFinite(appPort)) return appPort;
  const pluginPort = Number.parseInt(pluginSettings?.port, 10);
  if (Number.isFinite(pluginPort)) return pluginPort;
  return 8090;
};

function showTool(ctx, toolLabel, storedSettings, currentAppSettings) {
  const serverPort = resolveServerPort(storedSettings, currentAppSettings);
  const initialConfigJson = JSON.stringify(storedSettings)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');

  let html = readFileSync(join(__dirname, 'config.html'), 'utf-8');
  html = html.replace('__SERVER_PORT__', String(serverPort));
  html = html.replace('__INITIAL_CONFIG__', initialConfigJson);
  html = html.replace('__TOOL_MENU_LABEL__', toolLabel);

  ctx.showDialog(toolLabel, html, { size: 'large' });
}

export async function onLoad(ctx) {
  ctx.log('3DMesh plugin loaded');

  ctx.registerToolMenu('3DMesh', async () => {
    ctx.log('3DMesh tool opened');
    const serverState = ctx.getServerState();
    if (!serverState?.jobLoaded?.filename) {
      ctx.showDialog('3DMesh', '<div style="padding: 30px; text-align: center; color: var(--color-text-secondary);"><h3 style="color: var(--color-text-primary); margin-bottom: 12px;">No G-code Program Loaded</h3><p>Please load a G-code program first before using 3DMesh.</p></div>', { size: 'small' });
      return;
    }
    showTool(ctx, '3DMesh', ctx.getSettings() || {}, ctx.getAppSettings() || {});
  }, { clientOnly: true, icon: 'logo.png' });
}

export async function onUnload(ctx) {
  ctx.log('3DMesh plugin unloaded');
}
