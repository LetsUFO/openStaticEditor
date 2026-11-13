<script setup lang="ts">
import { computed, watch } from 'vue';
import { get, set } from 'lodash';
import { useConfigStore } from '@renderer/stores/config';

import { Form, Input, InputNumber, Select, Switch } from 'ant-design-vue';
import { AppstoreAddOutlined } from '@ant-design/icons-vue';

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
	let out = '';
	switch (item.type) {
		case 'enumText': {
			// 从 store 里按 name 路径取原始值（ID），再去 useEnumMap 指定的映射表找 label
			const raw = item?.name ? get(source.value, item.name) : undefined;
			const map = item?.useEnumMap ? get(source.value, item.useEnumMap) : null;
			if (raw != null && map && typeof map === 'object') {
				out = map[String(raw)] ?? raw; // 找不到时原样回显原始值
			} else {
				out = raw; // 无映射表时直接显示原始值
			}
			break;
		}
		default:
			out = item?.name ? get(source.value, item.name) : undefined;
			break;
	}
	return out;
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
		const fn = source.value[item.optionFilterFn];
		if (typeof fn === 'function') {
			const useData = item.optionUse ? get(source.value ?? {}, item.optionUse) : undefined;
			try {
				return normalizeOptions(fn(model.value, useData));
			} catch (error) {
				console.error(
					`[FormBuilder] optionFilterFn(${item.optionFilterFn}) 执行失败：`,
					error
				);
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

/** 选项标记（如「已测」）：选项数据里 optionBeforeTag.key 为 truthy 时返回标记配置 */
function optionTag(li: any, item: AppMenuFormField) {
	const tag = item?.optionBeforeTag;
	return tag && li?.[tag.key] ? tag : null;
}

/** 块级启停：外部直接传入数据路径，该路径值 truthy 时启用，否则禁用；路径为空则始终启用 */
function isBlockEnabled(path?: string): boolean {
	if (!path) return true;
	return !!get(source.value, path);
}

/** InputNumber 失焦校正：antd 的 min/max 只裁剪已输入的数值，空值不会自动补 min，这里手动兜底 */
function onNumberBlur(item: AppMenuFormField) {
	const val = read(item);
	const min = item.min;
	const max = item.max;
	if (val == null || Number.isNaN(val)) {
		if (min != null) write(item, min);
	} else if (min != null && val < min) {
		write(item, min);
	} else if (max != null && val > max) {
		write(item, max);
	}
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
				class="px-4 pt-4 pb-2 text-fcLv3 text-base border-b border-split italic"
			>
				{{ block.label }}
				<span v-if="block.tip" class="ml-2 text-xs text-fcLv1 italic">{{ block.tip }}</span>
			</div>
			<div
				class="mt-2 px-4 flex flex-wrap"
				:class="{ 'opacity-20 pointer-events-none': !isBlockEnabled(block.enableKey) }"
			>
				<div
					v-for="(item, ii) in block.items || []"
					:key="`${item.name || item.label}-${ii}`"
					:style="{ width: `${100 / (block.col || 3)}%` }"
				>
					<Form.Item class="!pr-4 !box-border">
						<template #label>
							<AppstoreAddOutlined
								class="text-fcLv1! mr-2"
								:style="{ fontSize: '1rem' }"
							/>{{ item.label }}
						</template>
						<InputNumber
							v-if="item.type == 'number'"
							:value="read(item)"
							:min="item.min"
							:max="item.max"
							:step="item.step"
							:precision="item.precision || 0"
							:disabled="item.disabled"
							class="w-full!"
							@update:value="(v) => write(item, v)"
							@blur="() => onNumberBlur(item)"
						></InputNumber>
						<Select
							v-else-if="item.type == 'select'"
							:value="read(item)"
							:disabled="item.disabled"
							:placeholder="item.placeholder || '请选择'"
							:show-search="true"
							:option-filter-prop="'label'"
							:allowClear="true"
							class="w-full!"
							@update:value="(v) => write(item, v)"
						>
							<Select.Option
								v-for="li in optionsOf(item)"
								:key="li.label"
								:value="li.value"
							>
								<span
									v-if="optionTag(li, item)"
									:class="item.optionBeforeTag?.colorClass"
									>{{ item.optionBeforeTag?.text }}</span
								>
								{{ li.label }}</Select.Option
							>
						</Select>
						<Switch
							v-else-if="item.type == 'switch'"
							:checked="!!read(item)"
							:disabled="item.disabled"
							@change="(v) => write(item, v)"
						></Switch>
						<Input
							v-else-if="item.type == 'input'"
							:value="read(item)"
							:disabled="item.disabled"
							:placeholder="item.placeholder || ''"
							class="w-full!"
							@update:value="(v) => write(item, v)"
						></Input>
						<template v-else-if="item.type == 'enumText'">{{ read(item) }}</template>
						<template v-else>{{ read(item) }}</template>
					</Form.Item>
				</div>
			</div>
		</template>
	</Form>
</template>

<style scoped></style>
