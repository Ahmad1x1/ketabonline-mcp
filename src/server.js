/**
 * KetabOnline MCP Server v1.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Akses API publik ketabonline.com — perpustakaan digital Islam
 * API Base : https://backend.ketabonline.com/api/v2
 * CDN      : https://s2.ketabonline.com/books
 *
 * Tools:
 *   1. cari_kitab         → cari buku berdasarkan judul/query
 *   2. info_kitab         → metadata lengkap kitab by ID
 *   3. daftar_isi_kitab   → daftar isi/TOC kitab
 *   4. baca_kitab         → baca isi halaman kitab (konversi ke teks bersih)
 *   5. cari_pengarang     → cari pengarang berdasarkan nama
 *   6. info_pengarang     → biografi pengarang by ID
 *   7. daftar_kategori    → daftar kategori buku
 *   8. info_kategori      → detail kategori by ID
 */

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getBooks, getBookInfo, getBookContents, getBookIndex, flattenIndex, getAuthors, getAuthorInfo, getCategories, getCategoryInfo, htmlToMarkdown, splitPageFootnotes, removeFootnoteReferences } from 'ketab-online-sdk';
import { z } from 'zod';
import { randomUUID } from 'crypto';

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: '2mb' }));

// ─── Helper: strip HTML jadi teks bersih ─────────────────────────────────────
function stripHtml(html = '') {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ─── Helper: format info buku singkat ────────────────────────────────────────
function formatBookShort(b, i) {
  const authors = (b.authors || []).map(a => a.name).join(', ') || '—';
  const cats    = (b.categories || []).map(c => c.name).join(', ') || '—';
  return [
    `[${i}] 📖 ${b.title}`,
    `    🆔 ID      : ${b.id}`,
    `    ✍️  Pengarang: ${authors}`,
    `    🗂️  Kategori : ${cats}`,
    b.description ? `    📝 Deskripsi: ${stripHtml(b.description).slice(0, 150)}…` : null,
    b.pages_count ? `    📄 Halaman  : ${b.pages_count}` : null,
    b.source      ? `    📚 Sumber   : ${b.source}` : null,
    `    🔗 URL      : https://ketabonline.com/ar/books/${b.id}`,
  ].filter(Boolean).join('\n');
}

// ─── Helper: format info buku lengkap ────────────────────────────────────────
function formatBookFull(b) {
  const authors  = (b.authors || []).map(a => `${a.name} (ID: ${a.id})`).join(', ') || '—';
  const cats     = (b.categories || []).map(c => `${c.name} (ID: ${c.id})`).join(', ') || '—';
  const parts    = (b.parts || []).map(p => `Juz ${p.name}: ${p.pages} hal (page_id: ${p.page_id})`).join(' | ') || '—';

  return [
    `📖 ${b.title}`,
    `🆔 ID Kitab   : ${b.id}`,
    `✍️  Pengarang  : ${authors}`,
    `🗂️  Kategori   : ${cats}`,
    `📚 Sumber     : ${b.source || '—'}`,
    `📄 Halaman    : ${b.pages_count || '—'} | Juz/Part: ${b.parts_count || '—'}`,
    parts !== '—' ? `📦 Juz Detail : ${parts}` : null,
    b.bibliography ? `📋 Bibliografi: ${b.bibliography}` : null,
    b.description  ? `\n📝 Deskripsi:\n${stripHtml(b.description)}` : null,
    `\n🔗 Baca online: https://ketabonline.com/ar/books/${b.id}`,
    `💡 Tip: Gunakan tool daftar_isi_kitab dan baca_kitab dengan ID ${b.id}`,
  ].filter(Boolean).join('\n');
}

// ─── Factory MCP server ───────────────────────────────────────────────────────
function createMcpServer() {
  const server = new McpServer({ name: 'ketabonline-mcp', version: '1.0.0' });

  // ══════════════════════════════════════════════════════════════════════════
  // Tool 1: cari_kitab
  // ══════════════════════════════════════════════════════════════════════════
  server.registerTool('cari_kitab', {
    description:
      'Cari buku/kitab di ketabonline.com berdasarkan judul atau kata kunci. ' +
      'Database mencakup ribuan kitab Islam (fiqh, hadits, tafsir, aqidah, dll). ' +
      'Mengembalikan daftar kitab beserta ID, pengarang, kategori, dan deskripsi singkat.',
    inputSchema: z.object({
      query: z.string().describe(
        'Judul atau kata kunci pencarian dalam Arab atau Indonesia. ' +
        'Contoh: موسوعة الفقه | الأربعون النووية | فتاوى ابن باز'
      ),
      limit: z.number().int().min(1).max(20).optional().default(10).describe(
        'Jumlah hasil maksimal (default: 10, max: 20)'
      ),
      halaman: z.number().int().positive().optional().default(1).describe(
        'Nomor halaman hasil (default: 1)'
      ),
      hanya_judul: z.boolean().optional().default(false).describe(
        'true = cari di judul saja (lebih tepat). false = cari di semua field (default)'
      ),
    }),
  }, async ({ query, limit, halaman, hanya_judul }) => {
    try {
      const opts = { query, limit, page: halaman };
      if (hanya_judul) opts.scope = 'titles';

      const books = await getBooks(opts);

      if (!books || books.length === 0) {
        return { content: [{ type: 'text', text: `Tidak ada hasil untuk: "${query}"` }] };
      }

      const header = `✅ ${books.length} kitab ditemukan untuk "${query}" (hal ${halaman}):\n\n`;
      const body   = books.map((b, i) => formatBookShort(b, i + 1)).join('\n\n');
      return { content: [{ type: 'text', text: header + body }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ Error: ${err.message}` }] };
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Tool 2: info_kitab
  // ══════════════════════════════════════════════════════════════════════════
  server.registerTool('info_kitab', {
    description:
      'Ambil metadata lengkap sebuah kitab dari ketabonline.com berdasarkan ID. ' +
      'Mencakup: judul, pengarang, kategori, sumber, jumlah halaman, juz/part, ' +
      'bibliografi, dan deskripsi lengkap. ' +
      'ID kitab didapat dari hasil cari_kitab atau URL ketabonline.com/ar/books/ID.',
    inputSchema: z.object({
      book_id: z.number().int().positive().describe(
        'ID kitab di ketabonline.com. Contoh: 41768, 27018, 67768'
      ),
    }),
  }, async ({ book_id }) => {
    try {
      const b = await getBookInfo(book_id);
      return { content: [{ type: 'text', text: formatBookFull(b) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ Error: ${err.message}` }] };
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Tool 3: daftar_isi_kitab
  // ══════════════════════════════════════════════════════════════════════════
  server.registerTool('daftar_isi_kitab', {
    description:
      'Ambil daftar isi (TOC) dari sebuah kitab di ketabonline.com. ' +
      'Menampilkan struktur bab/fasal beserta nomor halaman. ' +
      'Gunakan sebelum baca_kitab untuk mengetahui struktur dan page_id yang dibutuhkan.',
    inputSchema: z.object({
      book_id: z.number().int().positive().describe('ID kitab di ketabonline.com'),
      juz: z.number().int().positive().optional().default(1).describe(
        'Nomor juz/part (default: 1)'
      ),
      hierarki: z.boolean().optional().default(false).describe(
        'true = tampilkan struktur bertingkat (bab > fasal > dll). false = daftar flat (default)'
      ),
    }),
  }, async ({ book_id, juz, hierarki }) => {
    try {
      
      const index = await getBookIndex(book_id, { isRecursive: hierarki, part: juz });

      if (!index || index.length === 0) {
        return { content: [{ type: 'text', text: `Daftar isi kosong untuk kitab ID ${book_id} juz ${juz}` }] };
      }

      const flat = hierarki ? flattenIndex(index) : index;

      const baris = flat.map((e, i) => {
        const indent = '  '.repeat(Math.max(0, (e.title_level || 1) - 1));
        return `${indent}[${i+1}] ${e.title} — hal. ${e.page} (page_id: ${e.page_id || e.page})`;
      }).join('\n');

      return {
        content: [{
          type: 'text',
          text: `📚 Daftar Isi Kitab ID ${book_id} | Juz ${juz} (${flat.length} entri):\n\n${baris}\n\n` +
                `💡 Gunakan page_id di tool baca_kitab untuk membaca bagian tertentu.`,
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ Error: ${err.message}` }] };
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Tool 4: baca_kitab
  // ══════════════════════════════════════════════════════════════════════════
  server.registerTool('baca_kitab', {
    description:
      'Baca isi halaman dari sebuah kitab di ketabonline.com. ' +
      'Mengunduh data kitab dan menampilkan teks halaman tertentu dalam format bersih. ' +
      'PERHATIAN: tool ini mengunduh seluruh data kitab (~beberapa MB), gunakan hanya untuk kitab kecil-sedang. ' +
      'Untuk kitab besar (>500 halaman), pertimbangkan membaca bab spesifik via page_id dari daftar_isi_kitab.',
    inputSchema: z.object({
      book_id: z.number().int().positive().describe('ID kitab di ketabonline.com'),
      dari_halaman: z.number().int().positive().optional().default(1).describe(
        'Nomor halaman pertama yang ingin dibaca (default: 1)'
      ),
      sampai_halaman: z.number().int().positive().optional().describe(
        'Nomor halaman terakhir (opsional, default: dari_halaman + 4, max rentang 20 hal)'
      ),
      mode: z.enum(['penuh', 'ringkas']).optional().default('penuh').describe(
        '"penuh" = teks lengkap per halaman. "ringkas" = 3 baris pertama per halaman (untuk navigasi cepat)'
      ),
    }),
  }, async ({ book_id, dari_halaman, sampai_halaman, mode }) => {
    try {
      

      const book    = await getBookContents(book_id);
      const pages   = book.pages || [];

      if (pages.length === 0) {
        return { content: [{ type: 'text', text: `Tidak ada halaman dalam kitab ID ${book_id}` }] };
      }

      // Tentukan rentang halaman
      const akhir  = sampai_halaman
        ? Math.min(sampai_halaman, dari_halaman + (mode === 'ringkas' ? 49 : 19))
        : dari_halaman + (mode === 'ringkas' ? 9 : 4);

      const targetPages = pages.filter(p => p.page >= dari_halaman && p.page <= akhir);

      if (targetPages.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `Halaman ${dari_halaman}–${akhir} tidak ditemukan. ` +
                  `Kitab ini memiliki ${pages.length} halaman (hal 1–${pages[pages.length-1]?.page || pages.length}).`,
          }],
        };
      }

      const header = `📖 ${book.title}\n` +
                     `✍️  ${(book.authors||[]).map(a=>a.name).join(', ') || '—'}\n` +
                     `📄 Hal ${dari_halaman}–${akhir} dari ${pages.length} halaman | ` +
                     `Mode: ${mode}\n`;

      const parts = targetPages.map(p => {
        const [body] = splitPageFootnotes(p.content || '');
        const clean  = removeFootnoteReferences(body);
        const md     = htmlToMarkdown(clean);

        if (mode === 'ringkas') {
          const preview = md.split('\n').filter(l => l.trim()).slice(0, 3).join(' ').slice(0, 300);
          return `[Hal ${p.page}] ${preview}…`;
        }
        return `${'─'.repeat(50)}\n📄 Halaman ${p.page}\n\n${md}`;
      });

      const separator = mode === 'ringkas' ? '\n' : '\n\n';
      return { content: [{ type: 'text', text: header + '\n' + parts.join(separator) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ Error: ${err.message}` }] };
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Tool 5: cari_pengarang
  // ══════════════════════════════════════════════════════════════════════════
  server.registerTool('cari_pengarang', {
    description:
      'Cari pengarang/ulama di database ketabonline.com berdasarkan nama. ' +
      'Mengembalikan daftar pengarang dengan ID, nama, dan jumlah kitab.',
    inputSchema: z.object({
      query: z.string().describe(
        'Nama pengarang dalam Arab. Contoh: ابن تيمية | النووي | ابن حجر | ابن باز'
      ),
      limit: z.number().int().min(1).max(20).optional().default(10).describe(
        'Jumlah hasil (default: 10)'
      ),
    }),
  }, async ({ query, limit }) => {
    try {
      const authors = await getAuthors({ query, limit });

      if (!authors || authors.length === 0) {
        return { content: [{ type: 'text', text: `Tidak ada pengarang untuk: "${query}"` }] };
      }

      const baris = authors.map((a, i) =>
        `[${i+1}] ✍️  ${a.name}\n    🆔 ID: ${a.id} | 📚 Jumlah kitab: ${a.books_count || '—'}`
      ).join('\n\n');

      return {
        content: [{
          type: 'text',
          text: `✅ ${authors.length} pengarang ditemukan untuk "${query}":\n\n${baris}\n\n` +
                `💡 Gunakan ID pengarang di tool info_pengarang atau cari_kitab.`,
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ Error: ${err.message}` }] };
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Tool 6: info_pengarang
  // ══════════════════════════════════════════════════════════════════════════
  server.registerTool('info_pengarang', {
    description:
      'Ambil biografi lengkap pengarang dari ketabonline.com berdasarkan ID. ' +
      'ID pengarang didapat dari hasil cari_pengarang atau info_kitab.',
    inputSchema: z.object({
      author_id: z.number().int().positive().describe(
        'ID pengarang di ketabonline.com. Contoh: 2 = ابن حزم, 1869 = حمد الحريقي'
      ),
    }),
  }, async ({ author_id }) => {
    try {
      const a = await getAuthorInfo(author_id);
      return {
        content: [{
          type: 'text',
          text: [
            `✍️  ${a.name}`,
            a.long_name && a.long_name !== a.name ? `📛 Nama lengkap: ${a.long_name}` : null,
            `🆔 ID: ${a.id} | 📚 Kitab: ${a.books_count || '—'} | 🌐 Bahasa: ${a.lang || '—'}`,
            a.resume ? `\n📖 Biografi:\n${a.resume}` : null,
            `\n🔗 https://ketabonline.com/ar/authors/${a.id}`,
          ].filter(Boolean).join('\n'),
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ Error: ${err.message}` }] };
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Tool 7: daftar_kategori
  // ══════════════════════════════════════════════════════════════════════════
  server.registerTool('daftar_kategori', {
    description:
      'Tampilkan daftar kategori buku di ketabonline.com. ' +
      'Gunakan ID kategori untuk menyempurnakan pencarian atau melihat kitab per bidang ilmu.',
    inputSchema: z.object({
      query: z.string().optional().describe(
        'Filter nama kategori (opsional). Contoh: فقه | حديث | تفسير'
      ),
      limit: z.number().int().min(1).max(50).optional().default(30).describe(
        'Jumlah kategori (default: 30)'
      ),
    }),
  }, async ({ query, limit }) => {
    try {
      const cats = await getCategories({ query, limit });

      if (!cats || cats.length === 0) {
        return { content: [{ type: 'text', text: 'Tidak ada kategori ditemukan.' }] };
      }

      const baris = cats.map((c, i) =>
        `[${String(i+1).padStart(2)}] 🆔 ${String(c.id).padStart(4)} | ${c.name}` +
        (c.books_count ? ` (${c.books_count} kitab)` : '')
      ).join('\n');

      return {
        content: [{
          type: 'text',
          text: `📚 Kategori ketabonline.com (${cats.length}):\n\n${baris}\n\n` +
                `💡 Gunakan info_kategori dengan ID untuk detail per kategori.`,
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ Error: ${err.message}` }] };
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Tool 8: info_kategori
  // ══════════════════════════════════════════════════════════════════════════
  server.registerTool('info_kategori', {
    description:
      'Ambil detail informasi sebuah kategori di ketabonline.com berdasarkan ID.',
    inputSchema: z.object({
      category_id: z.number().int().positive().describe(
        'ID kategori. Contoh: 2 = التفاسير'
      ),
    }),
  }, async ({ category_id }) => {
    try {
      const c = await getCategoryInfo(category_id);
      return {
        content: [{
          type: 'text',
          text: [
            `🗂️  ${c.name}`,
            `🆔 ID: ${c.id} | 📚 Jumlah kitab: ${c.books_count || '—'}`,
            c.parent ? `⬆️  Parent ID: ${c.parent}` : null,
            `🔗 https://ketabonline.com/ar/categories/${c.id}`,
          ].filter(Boolean).join('\n'),
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ Error: ${err.message}` }] };
    }
  });

  return server;
}

// ─── Session management ───────────────────────────────────────────────────────
const sessions = new Map();

async function handleMcp(req, res) {
  const sessionId = req.headers['mcp-session-id'] || randomUUID();
  let transport   = sessions.get(sessionId);

  if (!transport) {
    const mcpServer = createMcpServer();
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      onsessioninitialized: (id) => sessions.set(id, transport),
    });
    transport.onclose = () => sessions.delete(sessionId);
    await mcpServer.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
}

app.post('/mcp', handleMcp);
app.get('/mcp',  handleMcp);
app.delete('/mcp', handleMcp);

app.get('/', (_req, res) => {
  res.json({
    status:       'ok',
    service:      'KetabOnline MCP Server',
    version:      '1.0.0',
    mcp_endpoint: '/mcp',
    tools: [
      'cari_kitab',
      'info_kitab',
      'daftar_isi_kitab',
      'baca_kitab',
      'cari_pengarang',
      'info_pengarang',
      'daftar_kategori',
      'info_kategori',
    ],
    sumber: 'https://ketabonline.com/ar',
    api:    'https://backend.ketabonline.com/api/v2',
    active_sessions: sessions.size,
  });
});

app.listen(PORT, () => {
  console.log(`✅ KetabOnline MCP Server v1.0 aktif di port ${PORT}`);
  console.log(`   Endpoint : http://localhost:${PORT}/mcp`);
  console.log(`   Tools    : 8 tools`);
});
