import * as https from 'https';
import * as http from 'http';
import { ToolResult } from '../toolExecutor';

// ─── Web Tool Handlers ──────────────────────────────────────────────────────

/**
 * Search the web using DuckDuckGo Instant Answer API.
 * No API key required.
 */
export async function handleWebSearch(query: string): Promise<ToolResult> {
  if (!query) {
    return { success: false, output: 'Error: "query" argument is required.' };
  }

  try {
    // Use DuckDuckGo's HTML search endpoint for richer results
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const html = await fetchRawUrl(searchUrl);
    
    // Parse result snippets from the HTML
    const results: string[] = [];
    const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    
    let match;
    let count = 0;
    while ((match = resultRegex.exec(html)) !== null && count < 8) {
      const url = match[1] || '';
      const title = stripHtmlTags(match[2]).trim();
      const snippet = stripHtmlTags(match[3]).trim();
      
      if (title && snippet) {
        count++;
        results.push(`${count}. **${title}**\n   ${snippet}\n   URL: ${decodeURIComponent(url.replace('/l/?uddg=', '').split('&')[0])}`);
      }
    }

    if (results.length === 0) {
      // Fallback: try the DuckDuckGo Instant Answer API
      const apiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const apiRaw = await fetchRawUrl(apiUrl);
      const apiData = JSON.parse(apiRaw);

      const parts: string[] = [];
      if (apiData.AbstractText) {
        parts.push(`**Summary:** ${apiData.AbstractText}\nSource: ${apiData.AbstractURL || 'DuckDuckGo'}`);
      }
      if (apiData.RelatedTopics && apiData.RelatedTopics.length > 0) {
        parts.push('\n**Related:**');
        for (const topic of apiData.RelatedTopics.slice(0, 5)) {
          if (topic.Text) {
            parts.push(`- ${topic.Text}${topic.FirstURL ? ` (${topic.FirstURL})` : ''}`);
          }
        }
      }
      
      if (parts.length > 0) {
        return { success: true, output: `Web search results for "${query}":\n\n${parts.join('\n')}` };
      }
      
      return { success: true, output: `No results found for "${query}". Try rephrasing the query.` };
    }

    return {
      success: true,
      output: `Web search results for "${query}":\n\n${results.join('\n\n')}`
    };
  } catch (err: any) {
    return { success: false, output: `Web search failed: ${err.message}` };
  }
}

/**
 * Fetch the text content of a URL.
 * Strips HTML and truncates to a reasonable length.
 */
export async function handleFetchUrl(url: string): Promise<ToolResult> {
  if (!url) {
    return { success: false, output: 'Error: "url" argument is required.' };
  }

  // Basic URL validation
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  try {
    const rawContent = await fetchRawUrl(url);
    
    // Strip HTML tags and normalize whitespace
    let textContent = stripHtmlTags(rawContent);
    textContent = textContent
      .replace(/\s+/g, ' ')
      .replace(/\n\s*\n/g, '\n\n')
      .trim();

    // Truncate to ~4000 characters for context window efficiency
    const maxLen = 4000;
    if (textContent.length > maxLen) {
      textContent = textContent.substring(0, maxLen) + `\n\n... [truncated, ${textContent.length - maxLen} more characters]`;
    }

    return {
      success: true,
      output: `Content from ${url}:\n\n${textContent}`
    };
  } catch (err: any) {
    return { success: false, output: `Failed to fetch URL "${url}": ${err.message}` };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stripHtmlTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function fetchRawUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    
    const makeRequest = (reqUrl: string, redirectCount = 0) => {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'));
        return;
      }

      client.get(reqUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; LocalLLMCopilot/1.0)',
          'Accept': 'text/html,application/json,text/plain;q=0.9',
          'Accept-Language': 'en-US,en;q=0.5'
        },
        timeout: 10000
      }, (res) => {
        // Handle redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = res.headers.location.startsWith('http') 
            ? res.headers.location 
            : new URL(res.headers.location, reqUrl).href;
          makeRequest(redirectUrl, redirectCount + 1);
          return;
        }

        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }).on('error', reject);
    };

    makeRequest(url);
  });
}
