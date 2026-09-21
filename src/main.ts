import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory } from 'vue-router'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './styles/theme.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import App from './App.vue'
import ProjectList from './views/ProjectList.vue'
import ProjectDetail from './views/ProjectDetail.vue'
import Settings from './views/Settings.vue'
import Services from './views/Services.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/projects' },
    { path: '/projects', name: 'projects', component: ProjectList },
    { path: '/projects/:id', name: 'project-detail', component: ProjectDetail },
    { path: '/services', name: 'services', component: Services },
    { path: '/settings', name: 'settings', component: Settings }
  ]
})

const app = createApp(App)
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component as never)
}
app.use(createPinia())
app.use(router)
app.use(ElementPlus)
app.mount('#app')
