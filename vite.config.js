import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { quasar, transformAssetUrls } from "@quasar/vite-plugin";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [
    vue({
      template: { transformAssetUrls },
    }),

    quasar({
      sassVariables: "src/quasar-variables.sass",
    }),
  ],
  resolve: {
    alias: {
      src: fileURLToPath(new URL('./src', import.meta.url)),
      stream: fileURLToPath(new URL('./src/utils/planeacion/empty.js', import.meta.url))
    }
  },
  server: {
    host: '0.0.0.0'
  },
  build: {
    // Le indica a Vite que envíe los archivos compilados a la carpeta 'public'
    outDir: 'public',
    // 'false' evita que borre otros archivos estáticos si los tienes dentro de public/
    emptyOutDir: false
  }
});
