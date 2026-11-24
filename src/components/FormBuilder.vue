<script setup lang="ts">
import { computed, watch } from 'vue';
import { get, set } from 'lodash';
import { useConfigStore } from '@renderer/stores/config';
import { cleanScriptError } from '@renderer/lib/lib';

import { Form, Input, InputNumber, Select, Switch, message } from 'ant-design-vue';
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

/** 解析 name 里的动态段：如 partData[targetPart].hp，targetPart=12 时变成 partData[12].hp。
 *  只处理非数字段，数组下标（[0] 等）保持原样。 */
function resolvePath(path?: string): string {
	if (!path) return '';
	return path.replace(/\[([A-Za-z_$][\w$]*)\]/g, (raw, key) => {
		const value = get(source.value, key);
		return value == null || value === '' ? raw : `[${String(value)}]`;
	});
}

function read(item: AppMenuFormField): any {
	let out = '';
	switch (item.type) {
		case 'templateSelect': {
			const path = templateEffectPath(item);
			out = path ? get(source.value, `${path}.class`) : undefined;
			break;
		}
		case 'enumText': {
			// 从 store 里按 name 路径取原始值（ID），再去 useEnumMap 指定的映射表找 label
			const raw = item?.name ? get(source.value, resolvePath(item.name)) : undefined;
			const map = item?.useEnumMap ? get(source.value, item.useEnumMap) : null;
			if (raw != null && map && typeof map === 'object') {
				out = map[String(raw)] ?? raw; // 找不到时原样回显原始值
			} else {
				out = raw; // 无映射表时直接显示原始值
			}
			break;
		}
		default:
			out = item?.name ? get(source.value, resolvePath(item.name)) : undefined;
			break;
	}
	return out;
}

function write(item: AppMenuFormField, value: any): void {
	if (!item?.name || !source.value) return;
	// 清空(allowClear)拿到的是 undefined，落 null，避免 JSON 序列化时整条键被丢掉
	set(source.value, resolvePath(item.name), value === undefined ? null : value);
}

// ------------------------------------------------------------------ 下拉选项
function normalizeOptions(list: any): { label: string; value: any; [key: string]: any }[] {
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

interface TemplateValueField {
	key: string;
	label?: string;
	rate?: number;
	show?: boolean;
	min?: number;
	max?: number;
	step?: number;
	precision?: number;
	defaultValue?: number;
	value?: number;
}

/** templateSelect 在 _passiveEffectList 中的下标；配置缺省时退回 name 里的下标 */
function templateEffectIndex(item: AppMenuFormField): number {
	if (item.index != null) return item.index;
	const m = /\[(\d+)\]/.exec(item.name ?? '');
	return m ? Number(m[1]) : 0;
}

/** templateSelect 对应的效果对象路径，如 MainWeapon._passiveEffectList[0] */
function templateEffectPath(item: AppMenuFormField): string {
	const path = item.name?.replace(/\.class$/, '') ?? '';
	if (!path) return '';
	return path.replace(/\[\d+\]$/, `[${templateEffectIndex(item)}]`);
}

/** templateSelect 对应的效果列表路径，如 MainWeapon._passiveEffectList */
function templateEffectListPath(item: AppMenuFormField): string {
	return templateEffectPath(item).replace(/\[\d+\]$/, '');
}

/** templateSelect 当前选中的原始 option；选项来自 effect.json -> effectList */
function selectedOption(item: AppMenuFormField): any {
	const path = templateEffectPath(item);
	const value = path ? get(source.value, `${path}.class`) : undefined;
	return optionsOf(item).find((li) => li.value === value) ?? null;
}

/** 当前选中效果模板声明的数值字段（effect.json 的 valueField） */
function templateValueFields(item: AppMenuFormField): TemplateValueField[] {
	const fields = selectedOption(item)?.valueField;
	return Array.isArray(fields) ? fields : [];
}

function templateValueListPath(item: AppMenuFormField): string {
	const path = templateEffectPath(item);
	return path ? `${path}.valueList` : '';
}

/** 输入框展示值 = store 原始值 × rate；未初始化的字段显示为空 */
function templateValue(item: AppMenuFormField, field: TemplateValueField): number | undefined {
	const path = templateValueListPath(item);
	const list = path ? get(source.value, path) : [];
	if (!Array.isArray(list)) return undefined;
	const entry = list.find((li) => li?.valueField === field.key);
	return typeof entry?.value === 'number' ? entry.value * (field.rate ?? 1) : undefined;
}

/** 输入框写回：展示值 ÷ rate 后写入当前效果 valueList 中 valueField 对应的子项 */
function writeTemplateValue(
	item: AppMenuFormField,
	field: TemplateValueField,
	value: number | string | null | undefined
): void {
	const path = templateValueListPath(item);
	if (!path || !source.value) return;
	const numericValue = value == null || value === '' ? Number.NaN : Number(value);
	let displayValue = Number.isNaN(numericValue) ? (field.min ?? 0) : numericValue;
	if (field.min != null) displayValue = Math.max(field.min, displayValue);
	if (field.max != null) displayValue = Math.min(field.max, displayValue);

	const current = get(source.value, path);
	const list = Array.isArray(current) ? [...current] : [];
	const index = list.findIndex((li) => li?.valueField === field.key);
	const entry = { valueField: field.key, value: displayValue / (field.rate ?? 1) };
	if (index >= 0) list[index] = entry;
	else list.push(entry);
	set(source.value, path, list);
}

/** 按模板生成词条说明文案，如「暴击率 + {value}%」 */
function describeTemplate(
	option: any,
	fields: TemplateValueField[],
	valueList: Array<{ valueField: string; value: number }>
): string | undefined {
	const label = option?.label;
	if (typeof label !== 'string') return undefined;
	const visible = fields.find((f) => f.show !== false) ?? fields[0];
	if (!visible) return label;
	const entry = valueList.find((li) => li.valueField === visible.key);
	if (!entry) return label;
	return label.replace(/\{value\}/g, String(entry.value * (visible.rate ?? 1)));
}

/**
 * 切换效果：
 * - 清空（删除）：从 _passiveEffectList 中移除该下标，后续词条前移
 * - 新增/替换：按新模板的 valueField 重建 valueList；已有下标原地替换，超出则追加
 */
function onTemplateChange(item: AppMenuFormField, value: any): void {
	const listPath = templateEffectListPath(item);
	if (!listPath || !source.value) return;

	const current = get(source.value, listPath);
	const list: any[] = Array.isArray(current)
		? current.filter((li) => li && typeof li === 'object')
		: [];
	const index = templateEffectIndex(item);

	if (value == null) {
		if (index >= list.length) return;
		list.splice(index, 1);
		set(source.value, listPath, list);
		return;
	}

	const option = optionsOf(item).find((li) => li.value === value);
	const fields: TemplateValueField[] = Array.isArray(option?.valueField) ? option.valueField : [];
	const valueList = fields.map((field) => {
		const displayValue = field.defaultValue ?? field.value ?? field.min ?? 0;
		return { valueField: field.key, value: displayValue / (field.rate ?? 1) };
	});
	const entry: Record<string, any> = { class: value, valueList };
	const description = describeTemplate(option, fields, valueList);
	if (description != null) entry.EffectDescriptionString = description;

	if (index < list.length) list[index] = entry;
	else list.push(entry);
	set(source.value, listPath, list);
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

// ------------------------------------------------------------------ 开关（script + onFnName/offFnName）
// 配置了 script 的 switch：开/关时主进程调用该模块里 onFnName/offFnName 指定的方法（各一次）。
// 等待方法及其 Promise 成功后才写入 store；失败时只展示错误，保留原值。
async function onSwitchChange(item: any, checked: boolean): Promise<void> {
	const method = checked ? item?.onFnName : item?.offFnName;
	if (!item?.script || !method) {
		write(item, checked);
		return;
	}
	try {
		await window.api.invokeScript({
			scriptSrc: item.script,
			method,
			// 开启时重新读取脚本文件；关闭不重载，调用开启时的同一实例
			reload: checked
		});
		write(item, checked);
	} catch (error: any) {
		message.error(`${item.label} 调用失败：${cleanScriptError(error)}`);
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
								:label="li.label"
								:title="li.label"
							>
								<span
									v-if="optionTag(li, item)"
									:class="item.optionBeforeTag?.colorClass"
									>{{ item.optionBeforeTag?.text }}</span
								>
								{{ li.label }}</Select.Option
							>
						</Select>
						<div v-else-if="item.type == 'templateSelect'">
							<Select
								:value="read(item)"
								:disabled="item.disabled"
								:placeholder="item.placeholder || '请选择'"
								:show-search="true"
								:option-filter-prop="'label'"
								:allowClear="true"
								class="w-full!"
								@update:value="(v) => onTemplateChange(item, v)"
							>
								<Select.Option
									v-for="li in optionsOf(item)"
									:key="li.label"
									:value="li.value"
									:label="li.label"
									:title="li.label"
								>
									<span
										v-if="optionTag(li, item)"
										:class="item.optionBeforeTag?.colorClass"
										>{{ item.optionBeforeTag?.text }}</span
									>
									{{ li.label }}
								</Select.Option>
							</Select>
							<ul class="flex pr-2 gap-1">
								<li
									v-for="vf in templateValueFields(item)"
									:key="vf.key"
									v-show="vf.show != false"
									class="flex-1"
								>
									<div class="text-fcLv1 mt-2 mb-1">{{ vf.label }}</div>
									<InputNumber
										:value="templateValue(item, vf)"
										:min="vf.min"
										:max="vf.max"
										:step="vf.step"
										:precision="vf.precision"
										class="w-full!"
										@update:value="(v) => writeTemplateValue(item, vf, v)"
									></InputNumber>
								</li>
							</ul>
						</div>
						<Switch
							v-else-if="item.type == 'switch'"
							:checked="!!read(item)"
							:disabled="item.disabled"
							@change="(v) => onSwitchChange(item, !!v)"
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
