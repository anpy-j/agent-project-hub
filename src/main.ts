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
import ProjectManagement from './views/ProjectManagement.vue'
import ProjectDetail from './views/ProjectDetail.vue'
import Settings from './views/Settings.vue'
import Services from './views/Services.vue'
import DiskCleaner from './views/DiskCleaner.vue'
import Delivery from './views/Delivery.vue'
import Skills from './views/Skills.vue'
import SkillsAssistant from './views/SkillsAssistant.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/projects' },
    {
      path: '/projects',
      component: ProjectManagement,
      children: [
        { path: '', name: 'projects', component: ProjectList },
        { path: 'services', name: 'services', component: Services }
      ]
    },
    { path: '/projects/:id', name: 'project-detail', component: ProjectDetail },
    { path: '/services', redirect: '/projects/services' },
    { path: '/delivery', name: 'delivery', component: Delivery },
    { path: '/disk-cleaner', name: 'disk-cleaner', component: DiskCleaner },
    { path: '/settings', name: 'settings', component: Settings },
    { path: '/ai/skills', name: 'skills', component: Skills },
    { path: '/ai/assistant', name: 'skills-assistant', component: SkillsAssistant },
    { path: '/ai/services', name: 'ai-services', redirect: { path: '/settings', query: { section: 'ai' } } }
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
