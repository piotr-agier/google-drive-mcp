import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setupTestServer, type TestContext } from '../helpers/setup-server.js';
import { ENABLED_TOOLS_ENV } from '../../src/utils/enabledTools.js';

// Set before the server module is first imported: it reads the list once.
process.env[ENABLED_TOOLS_ENV] = 'readGoogleDoc,getGoogleSheetContent';

let ctx: TestContext;
before(async () => {
  ctx = await setupTestServer();
});
after(async () => {
  await ctx.cleanup();
});

test('tools/list shows the enabled tools and nothing else', async () => {
  const { tools } = await ctx.client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['getGoogleSheetContent', 'readGoogleDoc']);
});

test('a call to a tool that is not enabled is refused before it reaches Google', async () => {
  const res: any = await ctx.client.callTool({ name: 'deleteItem', arguments: { itemId: 'x' } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Tool not enabled: deleteItem/);
  assert.equal(ctx.mocks.drive.tracker.calls.length, 0);
});
