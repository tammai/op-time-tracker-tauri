import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import ui from '@nuxt/ui/vue-plugin'
import { addCollection } from '@iconify/vue'
import lucide from 'virtual:lucide-subset'
import App from './App.vue'
import { installBridge } from './bridge'
import './assets/css/main.css'

// Bundle the icons instead of letting them be fetched.
//
// Nuxt UI's icons are Iconify names (`i-lucide-clock`), and outside a Nuxt build
// `@iconify/vue` resolves an unknown name by calling api.iconify.design at
// runtime. That is wrong here twice over: the app's CSP has no `connect-src` for
// it (correctly — the webview makes no HTTP requests of its own), so every icon
// silently rendered blank in the packaged build, and even with the CSP opened it
// would make a local desktop app's chrome depend on an internet round trip.
//
// `virtual:lucide-subset` holds only the icons this app can actually render,
// found by scanning the source *and* Nuxt UI's compiled theme at build time —
// see the plugin in `vite.config.ts` for why that scan is not a checked-in list.
addCollection(lucide)

// Before anything renders: the onboarding gate in `App.vue` calls
// `window.openproject.hasCredentials()` on mount, so the bridge has to exist by
// then. In the Electron app the preload script guaranteed that; here it is one
// explicit call.
installBridge()

const app = createApp(App)
// Order matters: Pinia first (Colada's query cache lives inside the Pinia
// store), then Colada, then Nuxt UI. See `docs/conventions-frontend.md`
// ("Server State: Pinia Colada").
const pinia = createPinia()
app.use(pinia)
app.use(PiniaColada)
app.use(ui)
app.mount('#app')
