import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './style.scss';

/**
 * config.json 改为在 App.vue 的 onMounted 里按需加载（支持传入 custom 子目录路径）。
 * 这里不再预加载，避免组件首次渲染时数据与实际加载的 config 不一致。
 */
const pinia = createPinia();
const app = createApp(App);
app.use(pinia);
app.mount('#app');
