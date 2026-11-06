<script setup lang="ts">
import { ref, watch } from 'vue';

const props = defineProps<{
	// custom 下扫描到的子目录名列表（由 App.vue 通过 listCustomDirs 传入）
	projectDirList: string[];
}>();

const emit = defineEmits<{
	// 选中某个项目，回传目录名（如 'ES2'）
	(e: 'select', dir: string): void;
}>();

interface ProjectMeta {
	dir: string;
	name: string;
	ver: string;
	appIcon: string;
}

// 每个子目录的展示信息（name / ver / appIcon 来自各自的 config.json）
const list = ref<ProjectMeta[]>([]);

watch(
	() => props.projectDirList,
	async (dirs) => {
		const items: ProjectMeta[] = [];
		for (const dir of dirs) {
			try {
				// getConfig 会按子目录重写路径，返回的 appIcon 已带 baseSrc 前缀（如 'ES2/Everspace2.png'）
				const cfg = await window.api.getConfig(`${dir}/config.json`);
				items.push({
					dir,
					name: cfg?.name || dir,
					ver: cfg?.ver || '',
					appIcon: cfg?.appIcon || ''
				});
			} catch {
				// 单个目录读取失败不影响其它项目展示
				items.push({ dir, name: dir, ver: '', appIcon: '' });
			}
		}
		list.value = items;
	},
	{ immediate: true }
);

// 图标路径解析：与 App.vue 的 appIconStyle 一致
// 相对路径走 app-asset 协议（主进程按 custom -> 项目根/resources 顺序解析）；
// data:/blob:/http(s) 直接使用
const iconUrl = (src: string): string => {
	if (!src) return '';
	if (/^(?:data:|blob:|http:|https:)/i.test(src)) return src;
	return `app-asset://local/?src=${encodeURIComponent(src)}`;
};
</script>

<template>
	<ul class="selectProject h-full text-center text-fcLv2">
		<li
			v-for="p in list"
			:key="p.dir"
			class="w-1/4 mt-20 px-4 inline-block cursor-pointer"
			@click="emit('select', p.dir)"
		>
			<img
				v-if="p.appIcon"
				class="icon block mx-auto mb-4 rounded-xl transition ease-in-out"
				:src="iconUrl(p.appIcon)"
			/>
			<div>{{ p.name }}</div>
			<div class="text-fcLv1 mt-1">{{ p.ver }}</div>
		</li>
	</ul>
</template>

<style lang="scss" scoped>
.selectProject {
	li:hover {
		.icon {
			opacity: 1;
			transform: scale(1.1);
		}
	}
}
.icon {
	width: 10rem;
	height: 10rem;
	box-shadow: 0 4rem 8rem rgba(0, 0, 0, 0.4);
	opacity: 0.6;
}
</style>
