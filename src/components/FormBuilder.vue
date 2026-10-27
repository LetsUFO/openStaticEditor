<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { get, set } from 'lodash';

import { Form, Input, InputNumber, Select } from 'ant-design-vue';
import { useConfigStore } from '@renderer/stores/config';

interface Props {
	/** config.json -> menu[].category（表单块数组） */
	config?: AppMenuFormItem[];
	/** 数据在 store.fileData 里的键，如 "base" */
	dataKey?: string;
}

const props = withDefaults(defineProps<Props>(), {
	config: () => [],
	dataKey: ''
});
const configStore = useConfigStore();

// ------------------------------------------------------------------ 路径读写
// config.json 里 items[].name 是「数据路径」(如 "currentShip.primaryWeapons[0].attributes[1].id")，
// 直接对上 es2_loadout.js 输出的嵌套结构；读取用 _.get、写入用 _.set（自动补全中间层）。

// ------------------------------------------------------------------ 数据源
// fileData[dataKey] 不存在时先建空对象，保证 dataKey 比数据更早就绪也不会写飞
watch(
	() => props.dataKey,
	(key) => {
		if (key && !configStore.fileData[key]) configStore.fileData[key] = {};
	},
	{ immediate: true }
);

/** 表单直接绑定 store 里的同一个对象，改完即回写，无需再同步 */
const source = computed<any>(() => (props.dataKey ? configStore.fileData[props.dataKey] : null));
const model = computed<Record<string, any>>(() => source.value || {});

function read(item: AppMenuFormField): any {
	return item?.name ? get(source.value, item.name) : undefined;
}

function write(item: AppMenuFormField, value: any): void {
	if (!item?.name || !source.value) return;
	// 清空(allowClear)拿到的是 undefined，落 null，避免 JSON 序列化时整条键被丢掉
	set(source.value, item.name, value === undefined ? null : value);
}

// ------------------------------------------------------------------ 下拉选项
function normalizeOptions(list: any): { label: string; value: any }[] {
	if (!Array.isArray(list)) return [];
	return list.map((opt) =>
		opt && typeof opt === 'object' && 'value' in opt ? opt : { label: String(opt), value: opt }
	);
}

/** 脚本算出来的选项，key = 脚本 + optionKey + 过滤函数，避免重复请求 */
const scriptOptions = ref<Record<string, any[]>>({});

async function loadScriptOptions(block: AppMenuFormItem): Promise<void> {
	const cfg = block?.loadScript;
	if (!cfg?.loadSrc) return;
	const dataKey = cfg.dataKey || props.dataKey;

	for (const item of block.items || []) {
		if (!item.optionKey) continue;
		const cacheKey = `${cfg.loadSrc}::${item.optionKey}::${item.optionFilterFn || ''}`;
		if (scriptOptions.value[cacheKey]) continue;
		try {
			const list = await window.api.runScript({
				scriptSrc: cfg.loadSrc,
				dataKey,
				data: dataKey ? configStore.fileData[dataKey] : null,
				itemName: item.name,
				optionKey: item.optionKey,
				optionFilterFn: item.optionFilterFn
			});
			scriptOptions.value[cacheKey] = list || [];
		} catch (error) {
			console.error(`[FormBuilder] 选项脚本执行失败：${cfg.loadSrc}`, error);
			scriptOptions.value[cacheKey] = []; // 失败了也占位，避免每次渲染都重跑
		}
	}
}

// 切分类、切 dataKey、文件数据落地时都重算一次脚本选项
watch(
	[() => props.config, () => props.dataKey, () => configStore.dataVersion],
	() => {
		(props.config || []).forEach((block) => loadScriptOptions(block));
	},
	{ immediate: true }
);

/** 选项优先级：脚本 loadScript > 静态 options（脚本未就绪时回退静态） */
function optionsOf(block: AppMenuFormItem, item: AppMenuFormField) {
	const cfg = block?.loadScript;
	if (cfg?.loadSrc && item?.optionKey) {
		const cacheKey = `${cfg.loadSrc}::${item.optionKey}::${item.optionFilterFn || ''}`;
		if (scriptOptions.value[cacheKey]) return normalizeOptions(scriptOptions.value[cacheKey]);
	}
	if (Array.isArray(item?.options) && item.options.length) {
		return normalizeOptions(item.options);
	}
	return [];
}

/** 供父组件（保存按钮）取当前分类的表单数据 */
function getFormData(): Record<string, any> {
	return source.value || {};
}
defineExpose({ getFormData });
</script>

<template>
	<Form :model="model" :layout="'vertical'">
		<template v-for="(block, bi) in props.config" :key="`${block.label}-${bi}`">
			<div
				v-if="block.label"
				class="px-4 pt-4 pb-2 text-fcLv1 text-base border-b border-split italic"
			>
				{{ block.label }}
				<span v-if="block.tip" class="ml-2 text-xs text-fcLv1 italic">{{ block.tip }}</span>
			</div>
			<div class="mt-2 px-4 flex flex-wrap">
				<Form.Item
					v-for="(item, ii) in block.items || []"
					:key="`${item.name || item.label}-${ii}`"
					:label="item.label"
					class="w-1/3 !pr-4"
				>
					<InputNumber
						v-if="item.type == 'number'"
						:value="read(item)"
						:min="item.min"
						:max="item.max"
						:step="item.step"
						:precision="item.precision"
						:disabled="item.disabled"
						class="w-full!"
						@update:value="(v) => write(item, v)"
					></InputNumber>
					<Select
						v-else-if="item.type == 'select'"
						:value="read(item)"
						:options="optionsOf(block, item)"
						:disabled="item.disabled"
						:placeholder="item.placeholder || '请选择'"
						:show-search="true"
						:option-filter-prop="'label'"
						class="w-full!"
						@update:value="(v) => write(item, v)"
					></Select>
					<Input
						v-else
						:value="read(item)"
						:disabled="item.disabled"
						:placeholder="item.placeholder || ''"
						class="w-full!"
						@update:value="(v) => write(item, v)"
					></Input>
				</Form.Item>
			</div>
		</template>
	</Form>
</template>

<style scoped></style>
