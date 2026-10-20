import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './style.scss';
import { useConfigStore } from './stores/config';

/**
 * 先把 custom/config.json（主进程 → IPC）载入 store，再挂载 App。
 * 之前是「先 mount、后异步 load」，组件首次渲染时 store 还是空的，
 * 因此 App.vue 一开始拿不到 menu / name 等数据。
 */
async function bootstrap(): Promise<void> {
	const pinia = createPinia();
	const app = createApp(App);
	app.use(pinia);

	try {
		await useConfigStore(pinia).load();
	} catch (error) {
		// 配置读取失败也不能卡住界面：store 保持初始状态，由组件自行降级
		console.error('[bootstrap] 加载 custom/config.json 失败：', error);
	}

	app.mount('#app');
}

bootstrap();
