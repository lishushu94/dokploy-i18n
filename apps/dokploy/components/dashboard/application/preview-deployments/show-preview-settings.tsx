import { zodResolver } from "@hookform/resolvers/zod";
import { HelpCircle, Plus, Settings2, X } from "lucide-react";
import { useTranslation } from "next-i18next";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input, NumberInput } from "@/components/ui/input";
import { Secrets } from "@/components/ui/secrets";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/utils/api";

const schema = z
	.object({
		env: z.string(),
		buildArgs: z.string(),
		buildSecrets: z.string(),
		wildcardDomain: z.string(),
		port: z.number(),
		previewLimit: z.number(),
		previewLabels: z.array(z.string()).optional(),
		previewHttps: z.boolean(),
		previewPath: z.string(),
		previewCertificateType: z.enum(["letsencrypt", "none", "custom"]),
		previewCustomCertResolver: z.string().optional(),
		previewRequireCollaboratorPermissions: z.boolean(),
	})
	.superRefine((input, ctx) => {
		if (
			input.previewCertificateType === "custom" &&
			!input.previewCustomCertResolver
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["previewCustomCertResolver"],
				message: "application.preview.validation.customCertResolverRequired",
			});
		}
	});

type Schema = z.infer<typeof schema>;

interface Props {
	applicationId: string;
}

export const ShowPreviewSettings = ({ applicationId }: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const [isEnabled, setIsEnabled] = useState(false);
	const { t } = useTranslation("common");
	const { mutateAsync: updateApplication, isLoading } =
		api.application.update.useMutation();

	const { data, refetch } = api.application.one.useQuery({ applicationId });

	const form = useForm<Schema>({
		defaultValues: {
			env: "",
			wildcardDomain: "*.traefik.me",
			port: 3000,
			previewLimit: 3,
			previewLabels: [],
			previewHttps: false,
			previewPath: "/",
			previewCertificateType: "none",
			previewRequireCollaboratorPermissions: true,
		},
		resolver: zodResolver(schema),
	});

	const previewHttps = form.watch("previewHttps");

	useEffect(() => {
		setIsEnabled(data?.isPreviewDeploymentsActive || false);
	}, [data?.isPreviewDeploymentsActive]);

	useEffect(() => {
		if (data) {
			form.reset({
				env: data.previewEnv || "",
				buildArgs: data.previewBuildArgs || "",
				buildSecrets: data.previewBuildSecrets || "",
				wildcardDomain: data.previewWildcard || "*.traefik.me",
				port: data.previewPort || 3000,
				previewLabels: data.previewLabels || [],
				previewLimit: data.previewLimit || 3,
				previewHttps: data.previewHttps || false,
				previewPath: data.previewPath || "/",
				previewCertificateType: data.previewCertificateType || "none",
				previewCustomCertResolver: data.previewCustomCertResolver || "",
				previewRequireCollaboratorPermissions:
					data.previewRequireCollaboratorPermissions || true,
			});
		}
	}, [data]);

	const onSubmit = async (formData: Schema) => {
		updateApplication({
			previewEnv: formData.env,
			previewBuildArgs: formData.buildArgs,
			previewBuildSecrets: formData.buildSecrets,
			previewWildcard: formData.wildcardDomain,
			previewPort: formData.port,
			previewLabels: formData.previewLabels,
			applicationId,
			previewLimit: formData.previewLimit,
			previewHttps: formData.previewHttps,
			previewPath: formData.previewPath,
			previewCertificateType: formData.previewCertificateType,
			previewCustomCertResolver: formData.previewCustomCertResolver,
			previewRequireCollaboratorPermissions:
				formData.previewRequireCollaboratorPermissions,
		})
			.then(() => {
				toast.success(t("application.preview.update.success"));
			})
			.catch((error) => {
				toast.error(error.message);
			});
	};
	return (
		<div>
			<Dialog open={isOpen} onOpenChange={setIsOpen}>
				<DialogTrigger asChild>
					<Button variant="outline">
						<Settings2 className="size-4" />
						{t("application.preview.button.configure")}
					</Button>
				</DialogTrigger>
				<DialogContent className="sm:max-w-5xl w-full">
					<DialogHeader>
						<DialogTitle>
							{t("application.preview.dialog.title")}
						</DialogTitle>
						<DialogDescription>
							{t("application.preview.dialog.description")}
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-4">
						<Form {...form}>
							<form
								onSubmit={form.handleSubmit(onSubmit)}
								id="hook-form-delete-application"
								className="grid w-full gap-4"
							>
								<div className="grid gap-4 lg:grid-cols-2">
									<FormField
										control={form.control}
										name="wildcardDomain"
										render={({ field }) => (
											<FormItem>
												<FormLabel>
													{t("application.preview.field.wildcardDomain.label")}
												</FormLabel>
												<FormControl>
													<Input
														placeholder={t(
															"application.preview.field.wildcardDomain.placeholder",
														)}
														{...field}
													/>
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="previewPath"
										render={({ field }) => (
											<FormItem>
												<FormLabel>
													{t("application.preview.field.path.label")}
												</FormLabel>
												<FormControl>
													<Input
														placeholder={t(
															"application.preview.field.path.placeholder",
														)}
														{...field}
													/>
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="port"
										render={({ field }) => (
											<FormItem>
												<FormLabel>
													{t("application.preview.field.port.label")}
												</FormLabel>
												<FormControl>
													<NumberInput
														placeholder={t(
															"application.preview.field.port.placeholder",
														)}
														{...field}
													/>
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="previewLabels"
										render={({ field }) => (
											<FormItem className="md:col-span-2">
												<div className="flex items-center gap-2">
													<FormLabel>
														{t("application.preview.field.labels.label")}
													</FormLabel>
													<TooltipProvider>
														<Tooltip>
															<TooltipTrigger asChild>
																<HelpCircle className="size-4 text-muted-foreground hover:text-foreground transition-colors cursor-pointer" />
															</TooltipTrigger>
															<TooltipContent>
																<p>
																	{t("application.preview.field.labels.tooltip")}
																</p>
															</TooltipContent>
														</Tooltip>
													</TooltipProvider>
												</div>
												<div className="flex flex-wrap gap-2 mb-2">
													{field.value?.map((label, index) => (
														<Badge
															key={index}
															variant="secondary"
															className="flex items-center gap-1"
														>
															{label}
															<X
																className="size-3 cursor-pointer hover:text-destructive"
																onClick={() => {
																	const newLabels = [...(field.value || [])];
																	newLabels.splice(index, 1);
																	field.onChange(newLabels);
																}}
															/>
														</Badge>
													))}
												</div>
												<div className="flex gap-2">
													<FormControl>
														<Input
															placeholder={t(
																"application.preview.field.labels.inputPlaceholder",
															)}
															onKeyDown={(e) => {
																if (e.key === "Enter") {
																	e.preventDefault();
																	const input = e.currentTarget;
																	const label = input.value.trim();
																	if (label) {
																		field.onChange([
																			...(field.value || []),
																			label,
																		]);
																		input.value = "";
																	}
																}
															}}
														/>
													</FormControl>
													<Button
														type="button"
														variant="outline"
														size="icon"
														onClick={() => {
															const input = document.querySelector(
																'input[placeholder*="Enter a label"]',
															) as HTMLInputElement;
															const label = input.value.trim();
															if (label) {
																field.onChange([...(field.value || []), label]);
																input.value = "";
															}
														}}
													>
														<Plus className="size-4" />
													</Button>
												</div>
												<FormMessage />
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="previewLimit"
										render={({ field }) => (
											<FormItem>
												<FormLabel>
													{t("application.preview.field.limit.label")}
												</FormLabel>
												<FormControl>
													<NumberInput
														placeholder={t(
															"application.preview.field.limit.placeholder",
														)}
														{...field}
													/>
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="previewHttps"
										render={({ field }) => (
											<FormItem className="flex flex-row items-center justify-between p-3 mt-4 border rounded-lg shadow-sm">
												<div className="space-y-0.5">
													<FormLabel>
														{t("application.preview.field.https.label")}
													</FormLabel>
													<FormDescription>
														{t("application.preview.field.https.description")}
													</FormDescription>
													<FormMessage />
												</div>
												<FormControl>
									<Switch
										checked={field.value}
										onCheckedChange={field.onChange}
									/>
								</FormControl>
							</FormItem>
						)}
					/>
					{previewHttps && (
						<FormField
							control={form.control}
							name="previewCertificateType"
							render={({ field }) => (
								<FormItem>
									<FormLabel>
										{t("application.preview.field.certificateType.label")}
									</FormLabel>
									<Select
										onValueChange={field.onChange}
										defaultValue={field.value || ""}
									>
										<FormControl>
											<SelectTrigger>
												<SelectValue
													placeholder={t(
														"application.preview.field.certificateType.placeholder",
													)}
												/>
											</SelectTrigger>
										</FormControl>

										<SelectContent>
											<SelectItem value="none">
												{t(
													"application.preview.field.certificateType.option.none",
												)}
											</SelectItem>
											<SelectItem value={"letsencrypt"}>
												{t(
													"application.preview.field.certificateType.option.letsencrypt",
												)}
											</SelectItem>
											<SelectItem value={"custom"}>
												{t(
													"application.preview.field.certificateType.option.custom",
												)}
											</SelectItem>
										</SelectContent>
									</Select>
									<FormMessage />
								</FormItem>
							)}
						/>
					)}

					{form.watch("previewCertificateType") === "custom" && (
						<FormField
							control={form.control}
							name="previewCustomCertResolver"
							render={({ field }) => (
								<FormItem>
									<FormLabel>
										{t(
											"application.preview.field.customCertResolver.label",
										)}
									</FormLabel>
									<FormControl>
										<Input
											placeholder={t(
												"application.preview.field.customCertResolver.placeholder",
											)}
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
					)}
					</div>
					<div className="grid gap-4 lg:grid-cols-2">
						<div className="flex flex-row items-center justify-between rounded-lg border p-4 col-span-2">
							<div className="space-y-0.5">
								<FormLabel className="text-base">
									{t("application.preview.field.enabled.label")}
								</FormLabel>
								<FormDescription>
									{t("application.preview.field.enabled.description")}
								</FormDescription>
							</div>
							<Switch
								checked={isEnabled}
								onCheckedChange={(checked) => {
									updateApplication({
										isPreviewDeploymentsActive: checked,
										applicationId,
									})
										.then(() => {
											refetch();
											toast.success(
												checked
													? t("application.preview.toast.enabled")
													: t("application.preview.toast.disabled"),
											);
										})
										.catch((error) => {
											toast.error(error.message);
										});
								}}
							/>
						</div>
					</div>

					<div className="grid gap-4 lg:grid-cols-2">
						<FormField
							control={form.control}
							name="previewRequireCollaboratorPermissions"
							render={({ field }) => (
								<FormItem className="flex flex-row items-center justify-between p-3 mt-4 border rounded-lg shadow-sm col-span-2">
									<div className="space-y-0.5">
										<FormLabel>
											{t("application.preview.field.requirePermissions.label")}
										</FormLabel>
										<FormDescription>
											{t("application.preview.field.requirePermissions.description")}
											<ul>
												<li>Admin</li>
												<li>Maintain</li>
												<li>Write</li>
											</ul>
										</FormDescription>
									</div>
									<FormControl>
										<Switch
											checked={field.value}
											onCheckedChange={field.onChange}
										/>
									</FormControl>
								</FormItem>
							)}
						/>
					</div>

					<FormField
						control={form.control}
						name="env"
						render={() => (
							<FormItem>
								<FormControl>
									<Secrets
										name="env"
										title={t("application.environment.card.title")}
										description={t("application.environment.card.description")}
										placeholder={t("application.environment.placeholder.env")}
									/>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
					{data?.buildType === "dockerfile" && (
						<Secrets
							name="buildArgs"
							title={t("application.environment.buildArgs.title")}
							description={
								<span>
									{t("application.environment.buildArgs.description")}
									<a
										className="text-primary"
										href="https://docs.docker.com/build/building/variables/"
										target="_blank"
										rel="noopener noreferrer"
									>
										{t("application.environment.buildArgs.link")}
									</a>
									.
								</span>
							}
							placeholder={t("application.environment.placeholder.buildArgs")}
						/>
					)}
					{data?.buildType === "dockerfile" && (
						<Secrets
							name="buildSecrets"
							title={t("application.environment.buildSecrets.title")}
							description={
								<span>
									{t("application.environment.buildSecrets.description")}
									<a
										className="text-primary"
										href="https://docs.docker.com/build/building/secrets/"
										target="_blank"
										rel="noopener noreferrer"
									>
										{t("application.environment.buildSecrets.link")}
									</a>
									.
								</span>
							}
							placeholder={t("application.environment.placeholder.buildSecrets")}
						/>
					)}
				</div>
			</form>
		</Form>
	</div>
				</DialogContent>
			</Dialog>
		</div>
	);
};
