import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './style.scss';
import { useConfigStore } from './stores/config';

const pinia = createPinia();
createApp(App).use(pinia).mount('#app');

// 启动时把主进程加载的 custom/config.json 拉进 store，供各 .vue 组件调用
useConfigStore(pinia).load();
