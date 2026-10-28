<script setup lang="ts">
import { computed, watch } from 'vue';
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

/** Select 选项的三级来源（优先级从高到低）：
 *  1. optionFilterFn —— store 里同名注入函数（functionTextList eval 注入），调用
 *     fn(fileData[dataKey] 完整子集, optionUse 抽取的数据)，返回值作为选项
 *  2. optionUse     —— 直接抽取 fileData[dataKey] 下该路径的数据作为选项
 *  3. options       —— config.json 里的静态选项（默认） */
function optionsOf(item: AppMenuFormField) {
	if (item?.optionFilterFn) {
		const fn = configStore.fileData[item.optionFilterFn];
		if (typeof fn === 'function') {
			const useData = item.optionUse
				? get(configStore.fileData[props.dataKey] ?? {}, item.optionUse)
				: undefined;
			try {
				return normalizeOptions(fn(model.value, useData));
			} catch (error) {
				console.error(`[FormBuilder] optionFilterFn(${item.optionFilterFn}) 执行失败：`, error);
				return [];
			}
		}
	}
	if (item?.optionUse) {
		return normalizeOptions(get(configStore.fileData[props.dataKey] ?? {}, item.optionUse));
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
						:options="optionsOf(item)"
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
