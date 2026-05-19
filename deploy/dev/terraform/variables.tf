variable "aws_region" {
  description = "AWS region for the dev deployment"
  type        = string
  default     = "us-west-2"
}

variable "name_prefix" {
  description = "Prefix for resource names"
  type        = string
  default     = "burble-dev"
}

variable "ssm_transfer_bucket_name" {
  description = "Private S3 bucket used by Ansible's aws_ssm connection plugin for file transfer. Must be globally unique."
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type. Use t4g.* for ARM."
  type        = string
  default     = "t4g.small"
}
