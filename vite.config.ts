import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    monkey({
      entry: 'src/main.ts',
      userscript: {
        name: 'DeepSeek Chat Enhance',
        namespace: 'ds-chat-enhance',
        version: '0.1.0',
        description: 'Enhancements for chat.deepseek.com',
        icon: 'https://chat.deepseek.com/favicon.ico',
        match: ['https://chat.deepseek.com/*'],
        'run-at': 'document-end',
      },
    }),
  ],
});
