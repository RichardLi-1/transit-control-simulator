/// <reference types="vitest/config" />
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { answerHelp } from './src/help/answer'
import type { TrainPosition } from './src/types/domain'

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function helpApiPlugin(anthropicKey: string | undefined) {
  return {
    name: 'help-api',
    configureServer(server: { middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0]
        if (path !== '/api/help' || req.method !== 'POST') {
          next()
          return
        }
        void (async () => {
          let body: {
            question?: string
            history?: { role: string; content: string }[]
            trains?: TrainPosition[]
          } = {}
          try {
            body = JSON.parse(await readBody(req)) as typeof body
          } catch {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'bad json' }))
            return
          }
          const result = await answerHelp({
            question: body.question ?? '',
            history: body.history ?? [],
            trains: Array.isArray(body.trains) ? body.trains : [],
            anthropicKey,
          })
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Cache-Control', 'no-store')
          res.end(JSON.stringify(result))
        })()
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), helpApiPlugin(env.ANTHROPIC_API_KEY || undefined)],
    resolve: {
      extensions: ['.tsx', '.ts', '.jsx', '.mjs', '.js', '.mts', '.json'],
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
    server: {
      proxy: {
        '/topology': 'http://localhost:8000',
        '/state': 'http://localhost:8000',
        '/commands': 'http://localhost:8000',
        '/health': 'http://localhost:8000',
        '/ops': 'http://localhost:8000',
        '/sim': 'http://localhost:8000',
        '/events': 'http://localhost:8000',
        '/ml': {
          target: 'http://localhost:8001',
          timeout: 120_000,
        },
      },
    },
  }
})
