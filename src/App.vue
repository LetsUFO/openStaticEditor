<script setup lang="ts">
import { useConfigStore } from './stores/config';
import { computed, reactive, ref } from 'vue';
import { storeToRefs } from 'pinia';

import { Button, Menu, message } from 'ant-design-vue';
import FormBuilder from './components/FormBuilder.vue';
import LoadFile from './components/LoadFile.vue';
import { dark } from './style/theme';

// 把 dark 的 fcLv 系列注入为 CSS 变量 --dark-fcLv*（单一来源 = theme.ts，供 style.scss 使用）
for (const [key, value] of Object.entries(dark)) {
	if (key.startsWith('fcLv')) {
		document.documentElement.style.setProperty(`--dark-${key}`, value as string);
	}
}

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
interface IState {
	loading: boolean;
	openKey: string[];
	activeMenu: any;
}
const state = reactive<IState>({
	loading: false,
	openKey: menu.value.map((li) => li?.key).filter((k): k is string => typeof k === 'string'),
	activeMenu: {}
});
const activeCategory = computed(() => {
	return state.activeMenu.category || [];
});

const $FormBuilder = ref();

const save = function (scriptSrc: string) {
	state.loading = true;
	//todo 拿到form数据，提交给这个地址的脚本
	message.success('保存成功！');
	state.loading = false;
};
</script>

<template>
	<div class="h-full">
		<LoadFile />
		<div class="flex justify-start h-full">
			<div class="menu w-[10rem] bg-primary overflow-y-auto">
				<Menu
					v-model:open-keys="state.openKey"
					:theme="'dark'"
					:items="menu"
					:mode="'inline'"
					class="relative select-none h-full"
					@select="
						({ item }) => {
							state.activeMenu = item;
						}
					"
				></Menu>
			</div>
			<div class="content flex-1 h-full overflow-y-auto">
				<FormBuilder
					:config="activeCategory"
					:dataKey="state.activeMenu.dataKey"
					ref="$FormBuilder"
				/>
				<div class="absolute bottom-4 right-4">
					<Button
						v-if="state.activeMenu?.category?.length"
						:type="'primary'"
						:loading="state.loading"
						@click="save(state.activeMenu.saveScript)"
						>保存</Button
					>
				</div>
			</div>
		</div>
	</div>
</template>

<style lang="scss" scoped>
.content {
	//底下多一点留白
	&::after {
		content: '';
		display: block;
		height: 1rem;
	}
}
</style>
