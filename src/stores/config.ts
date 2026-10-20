import { defineStore } from 'pinia';
import { ref } from 'vue';

// AppConfig 为全局类型，定义在 src/vite-env.d.ts（单一来源，避免字段两处漂移）

// custom/config.json 的渲染进程副本：
// 主进程读取后经 IPC 传来，供各 .vue 组件调用（窗口名/宽高也在这里可取）
export const useConfigStore = defineStore('config', () => {
	const config = ref<AppConfig | null>(null);

	async function load(): Promise<void> {
		config.value = await window.api.getConfig();
	}

	return { config, load };
});
