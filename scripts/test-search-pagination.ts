/**
 * Test script for search pagination functionality
 * 
 * Usage:
 *   npx tsx scripts/test-search-pagination.ts [searchQuery]
 * 
 * Examples:
 *   npx tsx scripts/test-search-pagination.ts          # searches for "test"
 *   npx tsx scripts/test-search-pagination.ts "report" # searches for "report"
 */

import { google, drive_v3 } from 'googleapis';
import { authenticate } from '../src/auth.js';

const SMALL_PAGE_SIZE = 3; // Small page size to easily test pagination

async function testSearchPagination(searchQuery: string) {
  console.log('🔍 Testing Search Pagination');
  console.log('════════════════════════════════════════\n');
  
  // Authenticate
  console.log('📝 Authenticating...');
  const oauth2Client = await authenticate();
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  
  console.log('✅ Authenticated successfully\n');
  
  // Prepare the search query
  const escapedQuery = searchQuery.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const formattedQuery = `fullText contains '${escapedQuery}' and trashed = false`;
  
  console.log(`🔎 Search query: "${searchQuery}"`);
  console.log(`📄 Page size: ${SMALL_PAGE_SIZE}`);
  console.log('════════════════════════════════════════\n');
  
  let pageToken: string | undefined = undefined;
  let pageNumber = 1;
  let totalFiles = 0;
  
  do {
    console.log(`📖 Page ${pageNumber}:`);
    console.log('────────────────────────────────────────');
    
    const res = await drive.files.list({
      q: formattedQuery,
      pageSize: SMALL_PAGE_SIZE,
      pageToken: pageToken,
      fields: "nextPageToken, files(id, name, mimeType, modifiedTime)",
    });
    
    const files = res.data.files || [];
    totalFiles += files.length;
    
    if (files.length === 0) {
      console.log('  (no files found)');
    } else {
      files.forEach((file: drive_v3.Schema$File, index: number) => {
        console.log(`  ${index + 1}. ${file.name}`);
        console.log(`     Type: ${file.mimeType}`);
        console.log(`     ID: ${file.id}`);
      });
    }
    
    // Check for next page
    pageToken = res.data.nextPageToken ?? undefined;
    
    if (pageToken) {
      console.log(`\n  ✅ nextPageToken received: ${pageToken.substring(0, 30)}...`);
      console.log('  → More results available!\n');
    } else {
      console.log('\n  ℹ️  No nextPageToken - this is the last page\n');
    }
    
    pageNumber++;
    
    // Safety limit to prevent infinite loops during testing
    if (pageNumber > 5) {
      console.log('⚠️  Stopping after 5 pages (safety limit)\n');
      break;
    }
    
  } while (pageToken);
  
  // Summary
  console.log('════════════════════════════════════════');
  console.log('📊 Summary:');
  console.log(`   Total pages fetched: ${pageNumber - 1}`);
  console.log(`   Total files found: ${totalFiles}`);
  console.log(`   Page size used: ${SMALL_PAGE_SIZE}`);
  
  if (totalFiles > SMALL_PAGE_SIZE) {
    console.log('\n✅ PAGINATION TEST PASSED!');
    console.log('   Successfully retrieved multiple pages of results.');
  } else if (totalFiles > 0) {
    console.log('\n✅ Search works, but not enough results to test pagination.');
    console.log('   Try a broader search query to get more results.');
  } else {
    console.log('\n⚠️  No files found. Try a different search query.');
  }
  
  console.log('\n════════════════════════════════════════\n');
}

// Main execution
const searchQuery = process.argv[2] || 'test';

testSearchPagination(searchQuery)
  .then(() => {
    console.log('Test completed.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  });

