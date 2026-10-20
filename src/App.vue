<script setup lang="ts">
import { useCounterStore } from './stores/counter';
import { useConfigStore } from './stores/config';
import { reactive } from 'vue';
import { storeToRefs } from 'pinia';

import { Menu } from 'ant-design-vue';
import HelloWorld from './components/HelloWorld.vue';
import LoadFile from './components/LoadFile.vue';

const counter = useCounterStore();

// menu 已在 store 里定义（store 负责把 config.json 的 menu 树转成 antd 需要的 items），
const configStore = useConfigStore();
const { menu } = storeToRefs(configStore);

/**
 * 只用 menu 推导 openKeys（不依赖 store 的 rootKeys）。
 * ItemType 是联合类型且可能为 null，key 的类型是 `Key | undefined`（Key = string | number），
 * 所以分两步收窄：
 *   1. `li?.key` —— 可选链，挡掉 TS18047（'li' is possibly 'null'）
 *   2. `.filter((k): k is string => ...)` —— 类型谓词，把 `(Key | undefined)[]` 收窄成 `string[]`，挡掉 TS2322
 */
const state = reactive<{ openKey: string[] }>({
	openKey: menu.value.map((li) => li?.key).filter((k): k is string => typeof k === 'string')
});
</script>

<template>
	<div class="h-full">
		<div class="flex justify-start h-full">
			<ul class="menu w-[10rem] bg-primary overflow-y-auto">
				<Menu
					v-model:open-keys="state.openKey"
					:theme="'dark'"
					:items="menu"
					:mode="'inline'"
					class="relative select-none h-full"
				></Menu>
			</ul>
			<div class="flex-1">
				<HelloWorld />
				<p class="sub">Vue 3 + Pinia + Electron 桌面应用骨架</p>
				<button @click="counter.decrement">-</button>
				<span class="value">
					count: <b>{{ counter.count }}</b> / double: <b>{{ counter.double }}</b>
				</span>
				<button @click="counter.increment">+</button>
			</div>
		</div>
	</div>
</template>

<style lang="scss" scoped></style>
