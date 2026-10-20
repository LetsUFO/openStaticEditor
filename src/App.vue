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

const state = reactive<{ openKey: string[] }>({
	openKey: menu.value.map((li) => li.key) || []
});
</script>

<template>
	<div class="h-full">
		<div class="flex justify-start h-full">
			<ul class="menu w-[10rem] bg-primary bgDarken">
				<Menu
					v-model:open-keys="state.openKey"
					:theme="'dark'"
					:items="menu"
					:mode="'inline'"
					class="relative select-none z-1"
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
